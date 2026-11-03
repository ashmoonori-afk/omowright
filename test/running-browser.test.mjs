import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunningBrowserError, connectRunningBrowser, findRunningBrowser } from "../src/running-browser.js";
import { SHELL, waitUntil } from "./fixtures/oopif-harness.mjs";
import { removeTreeSync } from "./fixtures/remove-tree.mjs";

function listen() {
  const server = createServer((socket) => socket.end());
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, close: () => new Promise((done) => server.close(done)) })));
}

async function closedPort() {
  const server = await listen();
  await server.close();
  return server.port;
}

function profileWith(content) {
  const dir = mkdtempSync(path.join(tmpdir(), "omowright-running-"));
  if (content !== undefined) writeFileSync(path.join(dir, "DevToolsActivePort"), content);
  return dir;
}

// Contract: discovery picks the profile whose recorded port is live, and leaves the user's
// profile untouched (a stale DevToolsActivePort is skipped, never deleted).
test("findRunningBrowser skips a stale DevToolsActivePort and keeps it on disk", async () => {
  const live = await listen();
  const staleContent = `${await closedPort()}\n/devtools/browser/stale\n`;
  const stale = profileWith(staleContent);
  const none = profileWith();
  const alive = profileWith(`${live.port}\n/devtools/browser/abc-123\n`);
  try {
    const found = await findRunningBrowser({ userDataDirs: [stale, none, alive] });
    assert.equal(found.wsUrl, `ws://127.0.0.1:${live.port}/devtools/browser/abc-123`);
    assert.equal(found.userDataDir, alive);
    assert.equal(readFileSync(path.join(stale, "DevToolsActivePort"), "utf8"), staleContent);
  } finally {
    await live.close();
    for (const dir of [stale, none, alive]) removeTreeSync(dir);
  }
});

// Contract: two live browsers are a choice for the caller, never a silent pick.
test("findRunningBrowser refuses to guess between two live browsers", async () => {
  const first = await listen();
  const second = await listen();
  const dirs = [profileWith(`${first.port}\n/devtools/browser/one\n`), profileWith(`${second.port}\n/devtools/browser/two\n`)];
  try {
    await assert.rejects(findRunningBrowser({ userDataDirs: dirs }), (error) => error instanceof RunningBrowserError && error.code === "choose_browser" && error.candidates.length === 2);
    await assert.rejects(findRunningBrowser({ userDataDirs: [profileWith()] }), (error) => error.code === "not_found");
  } finally {
    await first.close();
    await second.close();
    for (const dir of dirs) removeTreeSync(dir);
  }
});

// Contract: the file a real Chromium writes for --remote-debugging-port=0 resolves to a
// browser endpoint that attaches and drives a page.
test("connectRunningBrowser attaches to a running Chromium through its DevToolsActivePort", { skip: !SHELL && "no chromium binary found", timeout: 60_000 }, async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "omowright-running-live-"));
  const child = spawn(SHELL, ["--headless", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${userDataDir}`, "about:blank"], { stdio: "ignore" });
  let browser;
  try {
    await waitUntil(async () => {
      try {
        return readFileSync(path.join(userDataDir, "DevToolsActivePort"), "utf8").includes("/devtools/browser/");
      } catch {
        return false;
      }
    }, { label: "DevToolsActivePort" });
    const attached = await connectRunningBrowser({ userDataDirs: [userDataDir] });
    browser = attached.browser;
    const page = await browser.newTab("data:text/html,<title>attached</title><button>Running browser</button>");
    const snapshot = await page.snapshot();
    assert.ok(snapshot.tree.includes(`button "Running browser"`), snapshot.tree);
  } finally {
    await browser?.close().catch(() => {});
    child.kill("SIGKILL");
    await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once("exit", resolve)));
    removeTreeSync(userDataDir);
  }
});
