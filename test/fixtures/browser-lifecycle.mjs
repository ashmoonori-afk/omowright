// Shared helpers for the pipe-browser lifecycle tests: a scratch dir, a client
// driving the fake browser with a signal log, and a bounded condition wait.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PipeCdpClient } from "../../src/pipe.js";

export const fixture = fileURLToPath(new URL("./fake-pipe-browser.mjs", import.meta.url));
export const groupHarness = fileURLToPath(new URL("./pipe-group-harness.mjs", import.meta.url));
export const TERM_GRACE_MS = 5_000;

export function scratchDir() {
  return mkdtempSync(path.join(os.tmpdir(), "omowright-lifecycle-"));
}

export function readEvents(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => {
    const [event, at] = line.split(" ");
    return { event, at: Number(at) };
  });
}

// `onClose` defaults to "ignore" so close() goes on to the signal path these
// tests exercise; "exit" models a Chrome that quits on Browser.close.
export function lifecycleClient(dir, onTerm, extraArgs = [], logName = "signals.log", onClose = "ignore") {
  const logPath = path.join(dir, logName);
  const client = new PipeCdpClient({
    browserPath: process.execPath,
    browserArgs: [fixture, ...extraArgs],
    spawnOptions: { env: { ...process.env, FAKE_SIGNAL_LOG: logPath, FAKE_ON_TERM: onTerm, FAKE_ON_CLOSE: onClose } },
  });
  return { client, logPath };
}

export function waitFor(predicate, timeoutMs) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const deadline = Date.now() + timeoutMs;
  const tick = () => {
    if (predicate()) return resolve();
    if (Date.now() > deadline) return reject(new Error("condition not reached"));
    setTimeout(tick, 25);
  };
  tick();
  return promise;
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

// Spawn a caller process (own group) that connects the pipe transport and
// prints its browser's pid; resolves once the browser is up.
export async function spawnCaller(spawn, env, browserArgs = []) {
  const caller = spawn(process.execPath, [groupHarness, fixture, ...browserArgs], {
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, ...env },
  });
  caller.stdout.setEncoding("utf8");
  let out = "";
  await new Promise((resolve, reject) => {
    caller.stdout.on("data", (chunk) => { out += chunk; if (out.includes("\n")) resolve(); });
    caller.once("exit", () => reject(new Error(`harness exited early: ${out}`)));
  });
  const match = /^BROWSER_PID (\d+)/.exec(out);
  if (!match) throw new Error(`harness printed no browser pid: ${out}`);
  return { caller, browserPid: Number(match[1]) };
}
