// The pipe transport records the browser it spawns in a pidfile inside the
// profile (--user-data-dir), so a later launch on that profile can quit a browser
// whose caller died without close() (omo#12067). These tests guard that the
// pidfile never breaks or orphans a launch, and that the reap only ever touches
// a browser whose caller is dead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TERM_GRACE_MS, lifecycleClient, pidAlive, readEvents, scratchDir, spawnCaller, waitFor } from "./fixtures/browser-lifecycle.mjs";

const PID_FILE = "omowright-browser.pid";
const posixOnly = { skip: process.platform === "win32" };

test("a launch into a profile dir that does not exist yet connects and records its pidfile", { ...posixOnly, timeout: 20_000 }, async () => {
  const dir = scratchDir();
  const profile = path.join(dir, "not-yet", "profile");
  const { client } = lifecycleClient(dir, "exit", [`--user-data-dir=${profile}`]);
  try {
    await client.ensureConnected();
    const recorded = JSON.parse(readFileSync(path.join(profile, PID_FILE), "utf8"));
    assert.equal(recorded.pid, client.childProcess.pid);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pidfile that cannot be written fails the launch and quits the browser it spawned", { ...posixOnly, timeout: 20_000 }, async () => {
  const dir = scratchDir();
  const blocker = path.join(dir, "a-file");
  writeFileSync(blocker, "");
  // A unique argv marker finds the spawned browser by process table, so the check
  // does not depend on the fake having installed its signal handler yet.
  const marker = `--omowright-test-marker=${randomUUID()}`;
  const running = () => {
    try { execFileSync("pgrep", ["-f", marker], { stdio: "ignore" }); return true; } catch { return false; }
  };
  const { client } = lifecycleClient(dir, "exit", [`--user-data-dir=${path.join(blocker, "profile")}`, marker]);
  try {
    await assert.rejects(client.ensureConnected());
    assert.equal(client.isConnected, false);
    await waitFor(() => !running(), TERM_GRACE_MS + 2_000)
      .catch(() => assert.fail("the spawned browser was left running after the pidfile write failed"));
  } finally {
    await client.close();
    try { execFileSync("pkill", ["-KILL", "-f", marker], { stdio: "ignore" }); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an orphan whose caller died is reaped with SIGTERM and a grace window", { ...posixOnly, timeout: 30_000 }, async () => {
  const dir = scratchDir();
  const profile = path.join(dir, "profile");
  mkdirSync(profile);
  const pidFile = path.join(profile, PID_FILE);
  const orphanLog = path.join(dir, "orphan.log");
  let orphanPid;
  let caller;
  let second;
  try {
    let browserPid;
    ({ caller, browserPid } = await spawnCaller(spawn,
      { FAKE_SIGNAL_LOG: orphanLog, FAKE_ON_TERM: "ignore", FAKE_ON_EOF: "ignore" },
      [`--user-data-dir=${profile}`]));
    orphanPid = browserPid;
    const recorded = JSON.parse(readFileSync(pidFile, "utf8"));
    assert.equal(recorded.pid, browserPid);
    assert.equal(recorded.owner?.pid, caller.pid, "pidfile does not record the caller that owns the browser");
    // The caller dies without close(); its browser outlives it and holds the profile.
    const callerExit = new Promise((resolve) => caller.once("exit", resolve));
    process.kill(caller.pid, "SIGKILL");
    await callerExit;
    assert.ok(pidAlive(browserPid), "fixture browser should outlive its caller");

    second = lifecycleClient(dir, "exit", [`--user-data-dir=${profile}`]).client;
    await second.ensureConnected();
    const term = readEvents(orphanLog).find((entry) => entry.event === "TERM");
    assert.ok(term, "orphaned browser was not sent SIGTERM before being reaped");
    assert.ok(Date.now() - term.at >= TERM_GRACE_MS - 500, "orphan was SIGKILLed without a grace window");
    assert.equal(pidAlive(browserPid), false, "orphan survived the reap");
    assert.equal(JSON.parse(readFileSync(pidFile, "utf8")).pid, second.childProcess.pid);
    await second.close();
    assert.equal(existsSync(pidFile), false, "pidfile survived a clean close");
  } finally {
    await second?.close().catch(() => {});
    if (caller) try { process.kill(-caller.pid, "SIGKILL"); } catch {}
    if (orphanPid) try { process.kill(orphanPid, "SIGKILL"); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a browser whose caller is still alive is never reaped by a second launch on its profile", { ...posixOnly, timeout: 30_000 }, async () => {
  const dir = scratchDir();
  const profile = path.join(dir, "profile");
  mkdirSync(profile);
  const first = lifecycleClient(dir, "ignore", [`--user-data-dir=${profile}`], "first.log");
  const second = lifecycleClient(dir, "exit", [`--user-data-dir=${profile}`], "second.log");
  try {
    await first.client.ensureConnected();
    await second.client.ensureConnected();
    assert.equal(readEvents(first.logPath).some((entry) => entry.event === "TERM"), false,
      "a live client's browser was sent SIGTERM by another launch on the same profile");
    assert.equal(first.client.childProcess.exitCode, null);
    assert.equal(first.client.childProcess.signalCode, null);
  } finally {
    await second.client.close().catch(() => {});
    await first.client.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});
