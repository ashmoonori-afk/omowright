import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CdpCommandTimeoutError, CdpPipeClosedError, CdpSessionCrashedError, CdpSessionDetachedError, PipeCdpClient, connectPipe } from "../src/index.js";
import { TERM_GRACE_MS, fixture, lifecycleClient, readEvents, scratchDir, spawnCaller, waitFor } from "./fixtures/browser-lifecycle.mjs";

const harness = fileURLToPath(new URL("./fixtures/pipe-leak-harness.mjs", import.meta.url));
const failureBrowser = fileURLToPath(new URL("./fixtures/pipe-failures-browser.mjs", import.meta.url));

async function failureClient(t) {
  const client = new PipeCdpClient({ browserPath: process.execPath, browserArgs: [failureBrowser], logId: "pipe-failure-test" });
  t.after(async () => {
    const child = client.childProcess;
    if (child?.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    await client.close();
  });
  await client.ensureConnected();
  return client;
}

async function holdCommand(client, sessionId, opts = { timeoutMs: 1000 }) {
  const { promise, resolve } = Promise.withResolvers();
  const off = client.on("Fixture.held", params => { if (params.sessionId === sessionId) resolve(); });
  const outcome = client.send("Fixture.hold", undefined, sessionId, opts)
    .then(result => ({ result }), error => ({ error }));
  try {
    await Promise.race([promise, outcome.then(() => assert.fail("command settled before the child acknowledged it"))]);
  } finally {
    off();
  }
  return { outcome };
}

test("pipe timeout identifies its launch, session, target and absence of reply bytes", { timeout: 15_000 }, async t => {
  const client = await failureClient(t);
  const launches = new Set();
  for (let run = 0; run < 2; run++) {
    await client.ensureConnected();
    const pid = client.childProcess.pid;
    const { sessionId } = await client.send("Target.attachToTarget", { targetId: "target-a", flatten: true });
    await assert.rejects(client.send("Fixture.silent", undefined, sessionId, { timeoutMs: 100 }), error => {
      assert.ok(error instanceof CdpCommandTimeoutError);
      assert.equal(error.name, "CdpCommandTimeoutError");
      assert.equal(error.method, "Fixture.silent");
      assert.equal(error.sessionId, sessionId);
      assert.equal(error.targetId, "target-a");
      assert.equal(error.launchId, `pipe-failure-test:${pid}`);
      assert.ok(error.elapsedSinceLaunchMs >= error.commandElapsedMs);
      assert.equal(error.receivedReplyBytes, false);
      assert.equal(error.receivedBytesSinceSend, 0);
      for (const key of ["launchId", "sessionId", "targetId", "elapsedSinceLaunchMs", "receivedReplyBytes"]) {
        assert.ok(error.message.includes(`${key}=${error[key]}`), `timeout omits ${key}`);
      }
      assert.ok(error.message.includes("Fixture.silent"));
      launches.add(error.launchId);
      return true;
    });
    await client.close();
  }
  assert.equal(launches.size, 2);
});

test("pipe timeout distinguishes incoming traffic from an answered command", { timeout: 10_000 }, async t => {
  const client = await failureClient(t);
  await assert.rejects(client.send("Fixture.traffic", undefined, undefined, { timeoutMs: 100 }), error => {
    assert.ok(error instanceof CdpCommandTimeoutError);
    assert.equal(error.sessionId, null);
    assert.equal(error.targetId, null);
    assert.equal(error.receivedReplyBytes, true);
    assert.ok(error.receivedBytesSinceSend > 0);
    return true;
  });
});

test("pipe timeout counts malformed complete frames without losing later valid replies", { timeout: 10_000 }, async t => {
  const client = await failureClient(t);
  await assert.rejects(client.send("Fixture.malformed", undefined, undefined, { timeoutMs: 100 }), error => {
    assert.equal(error.malformedFrameCount, 1);
    assert.ok(error.message.includes("malformedFrameCount=1"));
    return true;
  });
  assert.equal((await client.send("Browser.getVersion")).product, "PipeFixture/1.0");
});

for (const event of ["end", "close"]) {
  test(`pipe ${event} rejects pending commands while the child is still alive`, { timeout: 10_000 }, async t => {
    const client = await failureClient(t);
    const { outcome } = await holdCommand(client, "session-a");
    let trigger;
    if (event === "end") {
      trigger = client.send("Fixture.end", undefined, undefined, { timeoutMs: 1000 })
        .then(result => ({ result }), error => ({ error }));
    } else {
      // Destroy the real parent fd: this emits close without a readable end.
      client.childProcess.stdio[4].destroy();
    }
    const { error } = await outcome;
    assert.ok(error instanceof CdpPipeClosedError, `expected CdpPipeClosedError, got ${error}`);
    assert.equal(error.method, "Fixture.hold");
    assert.equal(error.sessionId, "session-a");
    assert.equal(client.childProcess.exitCode, null);
    assert.equal(client.childProcess.signalCode, null);
    if (trigger) assert.ok((await trigger).error instanceof CdpPipeClosedError);
  });
}

// A helper process that inherited the CDP fd keeps the old launch's pipe open
// after close(); its EOF must not fail the commands of the launch that replaced it.
test("a previous launch's pipe EOF leaves the relaunched browser's pending commands alone", { timeout: 15_000 }, async t => {
  const client = await failureClient(t);
  const { pid: holderPid, probe } = await client.send("Fixture.shareOutput");
  console.log("PIPE_INHERITANCE_PROBE", process.platform, process.version, probe);
  t.after(() => { try { process.kill(holderPid, "SIGKILL"); } catch {} });
  const oldPipe = client.childProcess.stdio[4];
  const oldPipeClosed = once(oldPipe, "close");
  await client.close();
  console.log("PIPE_AFTER_CLOSE", { readableEnded: oldPipe.readableEnded, destroyed: oldPipe.destroyed });
  assert.equal(oldPipe.readableEnded, false, "the helper should still hold the old pipe open");
  await client.ensureConnected();
  const { outcome } = await holdCommand(client, "session-a", {});
  process.kill(holderPid, "SIGKILL");
  await oldPipeClosed;
  await client.send("Fixture.release", { sessionId: "session-a" });
  assert.deepEqual(await outcome, { result: { released: true } });
});

for (const [action, ErrorType] of [["detach", CdpSessionDetachedError], ["crash", CdpSessionCrashedError]]) {
  test(`pipe session ${action} rejects only that session's pending commands`, { timeout: 10_000 }, async t => {
    const client = await failureClient(t);
    const { sessionId } = await client.send("Target.attachToTarget", { targetId: "target-a", flatten: true });
    const affected = await holdCommand(client, sessionId);
    const other = await holdCommand(client, "session-b");
    const browser = await holdCommand(client, undefined);
    await client.send(`Fixture.${action}`, { sessionId });
    await client.send("Fixture.release", { sessionId: "session-b" });
    await client.send("Fixture.release", {});
    const { error } = await affected.outcome;
    assert.ok(error instanceof ErrorType, `expected ${ErrorType.name}, got ${error}`);
    assert.equal(error.sessionId, sessionId);
    assert.equal(error.targetId, "target-a");
    assert.deepEqual(await other.outcome, { result: { released: true } });
    assert.deepEqual(await browser.outcome, { result: { released: true } });
  });
}

const ALLOCATOR_LINE =
  "Trying to load the allocator multiple times. This is *not* supported.";

test("pipe target creation rejects the global-registry symbol", async () => {
  const client = new PipeCdpClient({ browserPath: process.execPath });
  await assert.rejects(client.send("Target.createTarget", { url: "about:blank" }, undefined, { capability: Symbol.for("omowright.targetCreationCapability") }), /reserved/);
});

test("pipe transport does not leak browser stdout/stderr to the parent tty", async () => {
  const child = spawn(process.execPath, [harness], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => { stderr += c; });
  const code = await new Promise((resolve) => child.on("close", resolve));

  assert.equal(code, 0, `harness failed:\n${stderr}`);
  assert.match(stdout, /HARNESS_OK FakeChrome\/1\.0/);
  assert.ok(!stderr.includes(ALLOCATOR_LINE), `browser stderr leaked to parent:\n${stderr}`);
  assert.ok(!stdout.includes("fake-browser stdout noise"), `browser stdout leaked to parent:\n${stdout}`);
});

test("readiness failure surfaces the drained browser stdio tail", { timeout: 15_000 }, async () => {
  const client = new PipeCdpClient({
    browserPath: process.execPath,
    browserArgs: [fixture],
    spawnOptions: { env: { ...process.env, FAKE_BROWSER_MODE: "mute-cdp" } },
    readinessTimeoutMs: 1500,
  });
  try {
    await assert.rejects(client.ensureConnected(), (err) => {
      assert.match(err.message, /did not become ready over the CDP pipe/);
      assert.match(err.message, /BOOM diagnostics 123/);
      return true;
    });
  } finally {
    await client.close();
  }
});

// connectPipe() returns no handle when it rejects, so a browser left running
// after a readiness failure can only be found in the process table (omo#9525).
test("connectPipe quits the browser it spawned when the browser never becomes ready", { skip: process.platform === "win32" && "pgrep finds the browser by its argv marker", timeout: 20_000 }, async () => {
  const marker = `--omowright-test-marker=${randomUUID()}`;
  const running = () => {
    try { execFileSync("pgrep", ["-f", "--", marker], { stdio: "ignore" }); return true; } catch { return false; }
  };
  try {
    await assert.rejects(connectPipe({
      browserPath: process.execPath,
      browserArgs: [fixture, marker],
      spawnOptions: { env: { ...process.env, FAKE_BROWSER_MODE: "mute-cdp" } },
      readinessTimeoutMs: 1500,
    }), /did not become ready over the CDP pipe/);
    await waitFor(() => !running(), TERM_GRACE_MS + 2_000)
      .catch(() => assert.fail("connectPipe rejected but left the browser it spawned running"));
  } finally {
    try { execFileSync("pkill", ["-KILL", "-f", "--", marker], { stdio: "ignore" }); } catch {}
  }
});

// A browser that dies during the readiness check must fail the launch once with
// its exit, not be relaunched by each readiness retry with a fresh budget (#123).
test("connectPipe rejects once, within the readiness budget, when the browser exits before ready", { timeout: 20_000 }, async () => {
  const dir = scratchDir();
  const logPath = path.join(dir, "starts.log");
  const readinessTimeoutMs = 5_000;
  let budgetTimer;
  const budget = new Promise((resolve) => { budgetTimer = setTimeout(() => resolve("budget expired"), readinessTimeoutMs); });
  try {
    const outcome = await Promise.race([
      connectPipe({
        browserPath: process.execPath,
        browserArgs: [fixture],
        spawnOptions: { env: { ...process.env, FAKE_BROWSER_MODE: "exit-early", FAKE_SIGNAL_LOG: logPath } },
        readinessTimeoutMs,
      }).then(() => "resolved", (error) => error),
      budget,
    ]);
    assert.ok(outcome instanceof Error, `connectPipe did not reject within the readiness budget: ${outcome}`);
    assert.match(outcome.message, /exited before it became ready/);
    assert.match(outcome.message, /exit code 1/);
    assert.match(outcome.message, /FATAL: fake browser cannot start/);
    assert.equal(readEvents(logPath).filter(({ event }) => event === "START").length, 1);
  } finally {
    clearTimeout(budgetTimer);
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Browser lifecycle: Chrome must get a graceful quit before any SIGKILL. ---
// Chrome deletes its per-launch macOS code-sign clone and temp profile only on a
// clean exit, so a SIGKILL that skips the quit leaks both (omo#12067). These
// tests use the fake browser above and never need a real Chrome. The pidfile and
// orphan-reap tests live in browser-pidfile.test.mjs.

// A signal cannot ask a Windows process to quit (child.kill() is TerminateProcess
// whatever the signal), so these two run on POSIX and the Windows pair below
// asserts the quit request Windows does have: CDP Browser.close.
const posixSignals = { skip: process.platform === "win32" && "no signal can ask a Windows process to quit" };
const windowsOnly = { skip: process.platform !== "win32" && "the POSIX pair above covers signals" };

test("close() sends SIGTERM and waits the grace window before SIGKILL", { ...posixSignals, timeout: 20_000 }, async () => {
  const dir = scratchDir();
  const { client, logPath } = lifecycleClient(dir, "ignore");
  try {
    await client.ensureConnected();
    const child = client.childProcess;
    const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal, at: Date.now() })));
    await client.close();
    const { signal, at } = await exit;
    const term = readEvents(logPath).find((entry) => entry.event === "TERM");
    assert.ok(term, "browser never received SIGTERM before being killed");
    assert.equal(signal, "SIGKILL");
    assert.ok(at - term.at >= TERM_GRACE_MS - 500, `SIGKILL came ${at - term.at} ms after SIGTERM; expected a ~${TERM_GRACE_MS} ms grace`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("close() lets a browser that honours SIGTERM quit cleanly, with no SIGKILL", { ...posixSignals, timeout: 20_000 }, async () => {
  const dir = scratchDir();
  const { client, logPath } = lifecycleClient(dir, "exit");
  try {
    await client.ensureConnected();
    const child = client.childProcess;
    const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    await client.close();
    assert.deepEqual(await exit, { code: 0, signal: null });
    assert.ok(readEvents(logPath).some((entry) => entry.event === "TERM"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("on Windows close() asks over CDP and waits the grace window before terminating", { ...windowsOnly, timeout: 20_000 }, async () => {
  const dir = scratchDir();
  const { client, logPath } = lifecycleClient(dir, "ignore", [], "signals.log", "ignore");
  try {
    await client.ensureConnected();
    const child = client.childProcess;
    const exit = new Promise((resolve) => child.once("exit", () => resolve(Date.now())));
    await client.close();
    const at = await exit;
    const asked = readEvents(logPath).find((entry) => entry.event === "CLOSE");
    assert.ok(asked, "browser was terminated without being asked to quit over CDP");
    assert.ok(at - asked.at >= TERM_GRACE_MS - 500, `terminated ${at - asked.at} ms after Browser.close; expected a ~${TERM_GRACE_MS} ms grace`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("on Windows close() lets a browser that honours Browser.close quit cleanly, with no forced kill", { ...windowsOnly, timeout: 20_000 }, async () => {
  const dir = scratchDir();
  const { client, logPath } = lifecycleClient(dir, "ignore", [], "signals.log", "exit");
  try {
    await client.ensureConnected();
    const child = client.childProcess;
    const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
    await client.close();
    assert.deepEqual(await exit, { code: 0, signal: null });
    assert.ok(readEvents(logPath).some((entry) => entry.event === "CLOSE"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a SIGKILL to the caller's process group leaves the browser to quit on pipe EOF", { skip: process.platform === "win32", timeout: 20_000 }, async () => {
  const dir = scratchDir();
  const logPath = path.join(dir, "signals.log");
  let caller;
  try {
    ({ caller } = await spawnCaller(spawn, { FAKE_SIGNAL_LOG: logPath }));
    process.kill(-caller.pid, "SIGKILL");
    await waitFor(() => readEvents(logPath).some((entry) => entry.event === "EOF"), 5_000)
      .catch(() => assert.fail("browser died with its caller's process group instead of quitting on pipe EOF"));
  } finally {
    if (caller) try { process.kill(-caller.pid, "SIGKILL"); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
