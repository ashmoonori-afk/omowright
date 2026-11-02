import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startFakeBskDaemon } from "./fixtures/fake-bsk-daemon.mjs";
import { BskIpcClient } from "../src/bsk/ipc-client.js";
import { bskDoctor, bskOnboard } from "../src/bsk/onboard.js";
import { installBskCli, cliInstallCommand } from "../src/bsk/install-cli.js";

const scoped = (home) => ({ exists: (p) => p.startsWith(home) && existsSync(p), signals: { defaultBrowser: null, running: [], lastUsed: {} } });

function macHomeWithChrome() {
  const home = mkdtempSync(path.join(tmpdir(), "omowright-onboard-"));
  mkdirSync(path.join(home, "Library/Application Support/Google/Chrome/Default"), { recursive: true });
  return home;
}

test("cliInstallCommand uses the official installers with an explicit install dir", () => {
  const unix = cliInstallCommand({ platform: "darwin", installDir: "/opt/x/bin" });
  assert.equal(unix.command, "sh");
  assert.deepEqual(unix.args, ["-c", "curl -fsSL https://raw.githubusercontent.com/Tencent/BrowserSkill/main/install.sh | sh"]);
  assert.equal(unix.env.BSK_INSTALL_DIR, "/opt/x/bin");
  const win = cliInstallCommand({ platform: "win32", installDir: "C:\\x\\bin" });
  assert.equal(win.command, "powershell");
  assert.ok(win.args.join(" ").includes("install.ps1"));
  assert.equal(win.env.BSK_INSTALL_DIR, "C:\\x\\bin");
});

test("installBskCli restores shell rc files the installer appended to", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "omowright-rc-"));
  const { writeFileSync, readFileSync } = await import("node:fs");
  try {
    writeFileSync(path.join(home, ".zshrc"), "export A=1\n");
    const installDir = path.join(home, "bin");
    const result = await installBskCli({
      platform: "darwin", home, installDir,
      run: async () => {
        writeFileSync(path.join(home, ".zshrc"), `export A=1\n\n# Added by browser-skill install.sh\nexport PATH="${installDir}:$PATH"\n`);
        writeFileSync(path.join(home, ".bashrc"), `\n# Added by browser-skill install.sh\nexport PATH="${installDir}:$PATH"\n`);
        mkdirSync(installDir, { recursive: true });
        writeFileSync(path.join(installDir, "bsk"), "#!/bin/sh\necho bsk 0.3.0\n", { mode: 0o755 });
        return { code: 0, stdout: "==> done\n", stderr: "" };
      },
    });
    assert.equal(result.installed, true);
    assert.equal(result.bskBin, path.join(installDir, "bsk"));
    assert.equal(readFileSync(path.join(home, ".zshrc"), "utf8"), "export A=1\n", "pre-existing rc file restored byte for byte");
    assert.deepEqual(result.restoredRcFiles.map((f) => path.basename(f)).sort(), [".bashrc", ".zshrc"]);
    let bashrcExists = true;
    try { readFileSync(path.join(home, ".bashrc")); } catch { bashrcExists = false; }
    assert.equal(bashrcExists, false, "an rc file the installer created from nothing is removed again");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("bskDoctor reports each layer: cli, daemon, browsers, extension registration", async () => {
  const daemon = await startFakeBskDaemon({
    handlers: { "system.status": () => ({ result: { daemon_version: "0.3.0-fake", protocol_version: "1.3", browsers: [], sessions: [] } }) },
  });
  const home = macHomeWithChrome();
  try {
    const client = new BskIpcClient({ home: daemon.home, autoStart: false });
    const report = await bskDoctor({ platform: "darwin", home, client, ...scoped(home), bskBin: null, waitForBrowserMs: 0 });
    assert.equal(report.cli.installed, false);
    assert.equal(report.daemon.running, true);
    assert.equal(report.daemon.version, "0.3.0-fake");
    assert.equal(report.daemon.protocolVersion, "1.3");
    assert.deepEqual(report.browsersConnected, []);
    assert.equal(report.browsers.length, 1);
    assert.equal(report.browsers[0].id, "chrome");
    assert.equal(report.browsers[0].extensionRegistered, false);
    assert.equal(report.ready, false);
    assert.match(report.nextStep, /install|register|extension/i);
  } finally { await daemon.close(); rmSync(home, { recursive: true, force: true }); }
});

test("bskDoctor is ready when a browser is connected", async () => {
  const daemon = await startFakeBskDaemon({
    handlers: { "system.status": () => ({ result: { daemon_version: "0.3.0-fake", protocol_version: "1.3", browsers: [{ instance_id: "abc", browser_name: "chrome", browser_version: "153" }], sessions: [] } }) },
  });
  const home = macHomeWithChrome();
  try {
    const client = new BskIpcClient({ home: daemon.home, autoStart: false });
    const report = await bskDoctor({ platform: "darwin", home, client, ...scoped(home), bskBin: "/fake/bsk", cliVersion: async () => "bsk 0.3.0", waitForBrowserMs: 0 });
    assert.equal(report.cli.installed, true);
    assert.equal(report.cli.version, "0.3.0");
    assert.equal(report.browsersConnected.length, 1);
    assert.equal(report.ready, true);
    assert.equal(report.nextStep, null);
  } finally { await daemon.close(); rmSync(home, { recursive: true, force: true }); }
});

test("bskDoctor without a daemon reports it instead of throwing", async () => {
  const home = macHomeWithChrome();
  const bskHome = mkdtempSync(path.join(tmpdir(), "omowright-nodaemon-"));
  try {
    const client = new BskIpcClient({ home: bskHome, autoStart: false });
    const report = await bskDoctor({ platform: "darwin", home, client, ...scoped(home), bskBin: null, waitForBrowserMs: 0 });
    assert.equal(report.daemon.running, false);
    assert.match(report.daemon.error, /daemon\.json/);
    assert.equal(report.ready, false);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(bskHome, { recursive: true, force: true }); }
});

test("bskOnboard runs install -> daemon -> register and returns the single human step, then waits for the browser", async () => {
  let statusCalls = 0;
  const daemon = await startFakeBskDaemon({
    handlers: {
      "system.status": (frame) => {
        statusCalls += 1;
        const connected = statusCalls >= 3 ? [{ instance_id: "new", browser_name: "chrome", browser_version: "153" }] : [];
        return { result: { daemon_version: "0.3.0-fake", protocol_version: "1.3", browsers: connected, sessions: [], waited: frame.params?.wait_for_browser_ms } };
      },
    },
  });
  const home = macHomeWithChrome();
  const events = [];
  try {
    const client = new BskIpcClient({ home: daemon.home, autoStart: false });
    const result = await bskOnboard({
      platform: "darwin", home, client, ...scoped(home),
      bskBin: null,
      installCli: async () => { events.push("install"); return { installed: true, bskBin: "/fake/bsk", restoredRcFiles: [] }; },
      cliVersion: async () => "bsk 0.3.0",
      onHumanStep: (step) => { events.push(`human:${step.browser}`); },
      waitForBrowserMs: 50,
    });
    assert.deepEqual(events, ["install", "human:chrome"]);
    assert.equal(result.cli.installed, true);
    assert.equal(result.daemon.running, true);
    assert.equal(result.registrations.length, 1);
    assert.equal(result.registrations[0].registered, true);
    assert.match(result.registrations[0].humanStep, /Enable/);
    assert.equal(result.humanStep, null, "once the browser connected there is nothing left for the human");
    assert.equal(result.nextStep, null);
    assert.equal(result.browsersConnected.length, 1);
    assert.equal(result.ready, true);
    assert.ok(statusCalls >= 3, `waited through ${statusCalls} status polls`);
    const waits = daemon.requests.filter((r) => r.method === "system.status").map((r) => r.params?.wait_for_browser_ms);
    assert.ok(waits.slice(1).every((w) => w === 50), `later polls use the wait budget: ${waits}`);
  } finally { await daemon.close(); rmSync(home, { recursive: true, force: true }); }
});

test("bskOnboard with no daemon names the daemon and sends the user nothing, since it cannot see whether the extension is enabled", async () => {
  const home = macHomeWithChrome();
  const bskHome = mkdtempSync(path.join(tmpdir(), "omowright-onboard-nodaemon-"));
  const steps = [];
  try {
    const client = new BskIpcClient({ home: bskHome, autoStart: false });
    const result = await bskOnboard({
      platform: "darwin", home, client, ...scoped(home), bskBin: "/fake/bsk", cliVersion: async () => "bsk 0.3.3",
      onHumanStep: (step) => steps.push(step), waitForBrowserMs: 0, waitTotalMs: 0,
    });
    assert.equal(result.daemon.running, false);
    assert.deepEqual(result.registrations, []);
    assert.deepEqual(steps, []);
    assert.equal(result.humanStep, null);
    assert.equal(existsSync(path.join(home, "Library/Application Support/Google/Chrome/External Extensions")), false);
    assert.match(result.nextStep, /daemon/i);
    assert.equal(result.ready, false);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(bskHome, { recursive: true, force: true }); }
});

test("bskOnboard never launches a headless browser when no browser is found; it returns the store instruction", async () => {
  const daemon = await startFakeBskDaemon({
    handlers: { "system.status": () => ({ result: { daemon_version: "0.3.0-fake", protocol_version: "1.3", browsers: [], sessions: [] } }) },
  });
  const home = mkdtempSync(path.join(tmpdir(), "omowright-nobrowser-"));
  try {
    const client = new BskIpcClient({ home: daemon.home, autoStart: false });
    let installs = 0;
    const result = await bskOnboard({
      platform: "darwin", home, client, ...scoped(home), bskBin: "/fake/bsk", cliVersion: async () => "bsk 0.3.0",
      installCli: async () => { installs += 1; return { installed: false, bskBin: null, restoredRcFiles: [] }; },
      waitForBrowserMs: 0, waitTotalMs: 0,
    });
    assert.equal(installs, 0, "an installed CLI is never reinstalled");
    assert.equal(result.ready, false);
    assert.deepEqual(result.registrations, []);
    assert.match(result.humanStep, /Chrome|Edge|Chromium/);
    assert.match(result.humanStep, /chromewebstore\.google\.com/);
    assert.equal(result.nextStep, result.humanStep, "with the daemon up, nextStep is the step the user still owes");
  } finally { await daemon.close(); rmSync(home, { recursive: true, force: true }); }
});
