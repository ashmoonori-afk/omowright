import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PipeCdpClient } from "../src/pipe.js";
import { TERM_GRACE_MS, fixture, lifecycleClient, readEvents, scratchDir, spawnCaller, waitFor } from "./fixtures/browser-lifecycle.mjs";

const harness = fileURLToPath(new URL("./fixtures/pipe-leak-harness.mjs", import.meta.url));

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
