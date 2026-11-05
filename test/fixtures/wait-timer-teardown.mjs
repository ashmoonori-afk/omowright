import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectPipe, createAgentTabs } from "../../src/index.js";
import { removeTreeSync } from "./remove-tree.mjs";

// Track even unref'd timers: a settled wait must dispose its deadline, not
// merely hide it from the event loop. Isolation keeps other tests' timers out.
const schedule = globalThis.setTimeout;
const cancel = globalThis.clearTimeout;
const timers = new Map();
globalThis.setTimeout = (fn, ms, ...args) => {
  const stack = new Error().stack;
  const timer = schedule(() => {
    timers.delete(timer);
    fn(...args);
  }, ms);
  timers.set(timer, { ms, stack });
  return timer;
};
globalThis.clearTimeout = timer => {
  timers.delete(timer);
  return cancel(timer);
};

const profile = mkdtempSync(path.join(tmpdir(), "omowright-wait-timers-"));
let connection;
try {
  connection = await connectPipe({
    browserPath: process.env.SHELL_BIN,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${profile}`],
    storageRoot: profile,
  });
  const page = (await createAgentTabs(connection).create("about:blank")).page;
  await page.goto("data:text/html,<main>A local document with enough text for readiness.</main>");
  for (const state of ["interactive", "stable", "load", "domcontentloaded"]) {
    await page.waitForLoadState(state, { timeout: 5000 });
  }
  await assert.rejects(page.waitForLoadState("interactive", { timeout: 1 }), /Timed out/);
  assert.equal(await page.waitForFunction(() => true), true);
  await assert.rejects(page.waitForFunction(() => false, undefined, { timeout: 20 }), /timed out/);
  await page.close();
  await connection.close();
  assert.deepEqual([...timers.values()], [], "timers outlived settled waits or teardown");
} finally {
  await connection?.close();
  for (const timer of timers.keys()) cancel(timer);
  globalThis.setTimeout = schedule;
  globalThis.clearTimeout = cancel;
  removeTreeSync(profile);
}
