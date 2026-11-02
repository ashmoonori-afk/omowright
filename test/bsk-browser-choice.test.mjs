import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startFakeBskDaemon } from "./fixtures/fake-bsk-daemon.mjs";
import { BskIpcClient } from "../src/bsk/ipc-client.js";
import { catalogBrowsers } from "../src/bsk/browsers.js";
import { identifyBrowser } from "../src/bsk/identify-browser.js";
import { parseMacDefaultBrowser, parseProcessNames, parseWindowsProgId, probeBrowserSignals } from "../src/bsk/browser-signals.js";
import { bskDoctor, bskOnboard } from "../src/bsk/onboard.js";

const NOW = Date.parse("2026-09-24T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const MAC_DIRS = {
  chrome: "Library/Application Support/Google/Chrome",
  edge: "Library/Application Support/Microsoft Edge",
  brave: "Library/Application Support/BraveSoftware/Brave-Browser",
  arc: "Library/Application Support/Arc/User Data",
  aside: "Library/Application Support/Aside",
  opera: "Library/Application Support/com.operasoftware.Opera",
};
const app = (name) => `/Applications/${name}.app/Contents/MacOS/${name}`;

function macHome(ids) {
  const home = mkdtempSync(path.join(tmpdir(), "omowright-choice-"));
  for (const id of ids) mkdirSync(path.join(home, MAC_DIRS[id], "Default"), { recursive: true });
  return home;
}
const homeOnly = (home) => (p) => p.startsWith(home) && existsSync(p);
const macCatalog = (home) => catalogBrowsers({ platform: "darwin", home, exists: homeOnly(home) });

test("the default browser that is also in use wins over every other installed profile", () => {
  const home = macHome(["chrome", "edge", "brave", "aside"]);
  try {
    const result = identifyBrowser({
      catalog: macCatalog(home), now: NOW,
      signals: { defaultBrowser: "at.studio.asidebrowser", running: [app("Aside"), app("Brave Browser")], lastUsed: { aside: NOW - DAY, brave: NOW - DAY, chrome: NOW - 90 * DAY } },
    });
    assert.equal(result.primaryId, "aside");
    assert.equal(result.confidence, "default-and-in-use");
    assert.equal(result.needsChoice, false);
    assert.deepEqual(result.candidates.find((c) => c.id === "chrome").signals, [], "a stale Chrome profile carries no usage signal");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a default browser nobody is using while another one runs is a question, not a pick", () => {
  const home = macHome(["chrome", "arc"]);
  try {
    const result = identifyBrowser({ catalog: macCatalog(home), now: NOW, signals: { defaultBrowser: "com.google.chrome", running: [app("Arc")], lastUsed: { arc: NOW - DAY, chrome: NOW - 60 * DAY } } });
    assert.equal(result.needsChoice, true);
    assert.equal(result.primaryId, null);
    assert.match(result.reason, /Google Chrome is the default browser, but Arc is the one in use/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a Safari default asks for the Chromium browser to use and suggests the only one in use", () => {
  const home = macHome(["chrome", "brave"]);
  try {
    const result = identifyBrowser({ catalog: macCatalog(home), now: NOW, signals: { defaultBrowser: "com.apple.safari", running: [app("Brave Browser")], lastUsed: {} } });
    assert.equal(result.needsChoice, true);
    assert.equal(result.defaultBrowser.id, "safari");
    assert.equal(result.defaultBrowser.supported, false);
    assert.equal(result.suggested, "brave");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("without a readable default, the single browser in use wins and several in use is a question", () => {
  const home = macHome(["chrome", "edge", "brave"]);
  try {
    const one = identifyBrowser({ catalog: macCatalog(home), now: NOW, signals: { defaultBrowser: null, running: [], lastUsed: { edge: NOW - DAY } } });
    assert.equal(one.primaryId, "edge");
    assert.equal(one.confidence, "only-in-use");
    const two = identifyBrowser({ catalog: macCatalog(home), now: NOW, signals: { defaultBrowser: null, running: null, lastUsed: { edge: NOW - DAY, brave: NOW - 2 * DAY } } });
    assert.equal(two.needsChoice, true);
    assert.match(two.reason, /several browsers are in use/);
    const none = identifyBrowser({ catalog: macCatalog(home), now: NOW, signals: { defaultBrowser: null, running: null, lastUsed: {} } });
    assert.equal(none.needsChoice, true, "installed-but-silent profiles never become a guess");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("an explicit choice overrides the signals, and an unknown id asks instead of guessing", () => {
  const home = macHome(["chrome", "brave"]);
  try {
    const signals = { defaultBrowser: "com.google.chrome", running: [app("Google Chrome")], lastUsed: {} };
    const brave = identifyBrowser({ catalog: macCatalog(home), now: NOW, signals, explicit: "brave" });
    assert.equal(brave.primaryId, "brave");
    assert.equal(brave.confidence, "explicit");
    const bogus = identifyBrowser({ catalog: macCatalog(home), now: NOW, signals, explicit: "netscape" });
    assert.equal(bogus.needsChoice, true);
    assert.match(bogus.reason, /netscape/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("only an app in the Applications folders counts as running; automation Chromium builds do not", () => {
  const home = macHome(["chrome"]);
  try {
    const names = parseProcessNames("darwin", `${app("Google Chrome")}\n${home}/.cache/chromium-145/Chromium.app/Contents/MacOS/Chromium\n/usr/sbin/cfprefsd\n`);
    const result = identifyBrowser({ catalog: macCatalog(home), now: NOW, signals: { defaultBrowser: null, running: names, lastUsed: {} } });
    assert.equal(result.primaryId, "chrome");
    assert.equal(result.candidates.find((c) => c.id === "chrome").running, true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("signal parsers read LaunchServices, the Windows UserChoice ProgId and process tables", () => {
  const plist = JSON.stringify({ LSHandlers: [{ LSHandlerURLScheme: "mailto", LSHandlerRoleAll: "com.apple.mail" }, { LSHandlerURLScheme: "https", LSHandlerRoleAll: "at.studio.AsideBrowser" }] });
  assert.equal(parseMacDefaultBrowser(plist), "at.studio.asidebrowser");
  assert.equal(parseMacDefaultBrowser(JSON.stringify({ LSHandlers: [] })), "com.apple.safari", "no https handler means Safari");
  assert.equal(parseMacDefaultBrowser("not json"), null);
  assert.equal(parseWindowsProgId("\r\nHKEY_CURRENT_USER\\...\\UserChoice\r\n    ProgId    REG_SZ    BraveHTML\r\n"), "bravehtml");
  assert.equal(parseWindowsProgId(""), null);
  assert.deepEqual(parseProcessNames("win32", '"brave.exe","1234","Console","1","200,000 K"\r\n"explorer.exe","5","Console","1","1 K"'), ["brave.exe", "explorer.exe"]);
  assert.deepEqual(parseProcessNames("linux", "systemd\nchrome\nchrome\n"), ["systemd", "chrome"]);
});

test("probeBrowserSignals reads the per-user LaunchServices plist under the given home and degrades to null", async () => {
  const calls = [];
  const signals = await probeBrowserSignals({
    platform: "darwin", home: "/h", browsers: [{ id: "aside", userDataDir: "/h/ud" }],
    run: async (command, args) => { calls.push([command, ...args]); return command === "plutil" ? null : `${app("Aside")}\n`; },
    stat: (p) => { if (p === "/h/ud/Local State") return { mtimeMs: 42 }; throw new Error("ENOENT"); },
  });
  assert.equal(signals.defaultBrowser, null, "an unreadable default stays unknown");
  assert.deepEqual(signals.running, [app("Aside")]);
  assert.deepEqual(signals.lastUsed, { aside: 42 });
  assert.ok(calls.some((c) => c[0] === "plutil" && c.includes("/h/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist")));
});

async function withDaemon(fn) {
  const daemon = await startFakeBskDaemon({ handlers: { "system.status": () => ({ result: { daemon_version: "0.3.0-fake", protocol_version: "1.3", browsers: [], sessions: [] } }) } });
  try { return await fn(new BskIpcClient({ home: daemon.home, autoStart: false })); } finally { await daemon.close(); }
}
const extFile = (home, id, extId = "hhcmgoofomhgciiibhipgmgkgnoenaoi") => path.join(home, MAC_DIRS[id], "External Extensions", `${extId}.json`);

test("bskOnboard registers the extension only in the browser the user uses and names it in the human step", async () => {
  const home = macHome(["chrome", "edge", "brave", "aside"]);
  try {
    await withDaemon(async (client) => {
      const result = await bskOnboard({
        platform: "darwin", home, client, bskBin: "/fake/bsk", cliVersion: async () => "bsk 0.3.0", exists: homeOnly(home), now: NOW,
        signals: { defaultBrowser: "at.studio.asidebrowser", running: [app("Aside"), app("Brave Browser")], lastUsed: { aside: NOW - DAY } },
        waitForBrowserMs: 0, waitTotalMs: 0,
      });
      assert.equal(result.primary.id, "aside");
      assert.deepEqual(result.registrations.map((r) => r.browser), ["aside"]);
      assert.ok(existsSync(extFile(home, "aside")));
      for (const other of ["chrome", "edge", "brave"]) assert.equal(existsSync(extFile(home, other)), false, `${other} untouched`);
      assert.match(result.humanStep, /Quit Aside completely/);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("bskOnboard writes nothing and asks when the signals do not single out a browser", async () => {
  const home = macHome(["chrome", "brave"]);
  try {
    await withDaemon(async (client) => {
      const result = await bskOnboard({
        platform: "darwin", home, client, bskBin: "/fake/bsk", cliVersion: async () => "bsk 0.3.0", exists: homeOnly(home), now: NOW,
        signals: { defaultBrowser: "com.apple.safari", running: [], lastUsed: { chrome: NOW - DAY, brave: NOW - DAY } },
        waitForBrowserMs: 50, waitTotalMs: 5_000,
      });
      assert.equal(result.needsChoice, true);
      assert.deepEqual(result.registrations, []);
      assert.equal(existsSync(extFile(home, "chrome")), false);
      assert.equal(existsSync(extFile(home, "brave")), false);
      assert.match(result.humanStep, /^Ask the user which browser they actually use/);
      assert.match(result.humanStep, /Google Chrome \[chrome\]/);
      assert.match(result.humanStep, /Brave \[brave\]/);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("bskOnboard honours an explicit browser and hands store-only browsers their store link", async () => {
  const home = macHome(["chrome", "opera"]);
  try {
    await withDaemon(async (client) => {
      const result = await bskOnboard({
        platform: "darwin", home, client, bskBin: "/fake/bsk", cliVersion: async () => "bsk 0.3.0", exists: homeOnly(home), now: NOW,
        browser: "opera", signals: { defaultBrowser: "com.google.chrome", running: [app("Google Chrome")], lastUsed: {} },
        waitForBrowserMs: 0, waitTotalMs: 0,
      });
      assert.equal(result.primary.id, "opera");
      assert.equal(result.registrations[0].reason, "store_only");
      assert.match(result.humanStep, /chromewebstore\.google\.com.* in Opera/);
      assert.equal(existsSync(extFile(home, "chrome")), false);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("bskDoctor reports the identified browser and registrations an older onboarding left in other browsers", async () => {
  const home = macHome(["chrome", "aside"]);
  try {
    mkdirSync(path.dirname(extFile(home, "chrome")), { recursive: true });
    writeFileSync(extFile(home, "chrome"), JSON.stringify({ external_update_url: "https://clients2.google.com/service/update2/crx" }, null, 2) + "\n");
    await withDaemon(async (client) => {
      const report = await bskDoctor({
        platform: "darwin", home, client, bskBin: "/fake/bsk", cliVersion: async () => "bsk 0.3.0", exists: homeOnly(home), now: NOW,
        env: { OMOWRIGHT_BROWSER: "aside" }, signals: { defaultBrowser: null, running: [], lastUsed: {} },
      });
      assert.equal(report.primary.id, "aside");
      assert.equal(report.identification.confidence, "explicit");
      assert.deepEqual(report.identification.registeredElsewhere, ["chrome"]);
      assert.match(report.nextStep, /Register the BrowserSkill extension for Aside/);
      assert.equal(readFileSync(extFile(home, "chrome"), "utf8").includes("external_update_url"), true, "the doctor never removes anything");
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// Default contract: the browser the extension already runs in is the user's browser. A default the
// user does not drive (Edge on Windows) must not redirect onboarding or the doctor's report away from it.
test("the one browser whose extension is connected wins over a default browser that is also in use", async () => {
  const home = macHome(["chrome", "edge"]);
  const connected = [{ instance_id: "05394bb7", browser_name: "chrome", browser_version: "156" }];
  const daemon = await startFakeBskDaemon({ handlers: { "system.status": () => ({ result: { daemon_version: "0.4.1-fake", protocol_version: "1.8", browsers: connected, sessions: [] } }) } });
  try {
    const report = await bskDoctor({
      platform: "darwin", home, client: new BskIpcClient({ home: daemon.home, autoStart: false }), bskBin: null, exists: homeOnly(home), now: NOW,
      signals: { defaultBrowser: "com.microsoft.edgemac", running: [app("Google Chrome")], lastUsed: { chrome: NOW - DAY, edge: NOW - DAY } },
    });
    assert.equal(report.primary.id, "chrome");
    assert.equal(report.identification.confidence, "connected");
    assert.equal(report.ready, true);
  } finally { await daemon.close(); rmSync(home, { recursive: true, force: true }); }
});

// BrowserSkill's extension names its browser from navigator.userAgent, and every Chromium fork that keeps
// Chrome's user agent (Brave, Arc, Vivaldi, ...) reports "chrome". Such a name is evidence only when
// exactly one browser that could have sent it is running.
test("a Chromium fork whose extension reports itself as chrome is not taken for Chrome", async () => {
  const home = macHome(["chrome", "edge", "brave"]);
  const connected = [{ instance_id: "05394bb7", browser_name: "chrome", browser_version: "156" }];
  const daemon = await startFakeBskDaemon({ handlers: { "system.status": () => ({ result: { daemon_version: "0.4.1-fake", protocol_version: "1.8", browsers: connected, sessions: [] } }) } });
  try {
    const report = await bskDoctor({
      platform: "darwin", home, client: new BskIpcClient({ home: daemon.home, autoStart: false }), bskBin: null, exists: homeOnly(home), now: NOW,
      signals: { defaultBrowser: "com.microsoft.edgemac", running: [app("Brave Browser")], lastUsed: { chrome: NOW - DAY, edge: NOW - DAY, brave: NOW - DAY } },
    });
    assert.equal(report.primary.id, "brave", "the only running browser that sends Chrome's user agent is the one connected");
    assert.equal(report.identification.confidence, "connected");
  } finally { await daemon.close(); rmSync(home, { recursive: true, force: true }); }
});

test("a connected chrome name with several or no running candidates proves nothing and falls back to the signals", () => {
  const home = macHome(["chrome", "edge", "brave"]);
  try {
    const lastUsed = { chrome: NOW - DAY, edge: NOW - DAY, brave: NOW - DAY };
    const both = identifyBrowser({ catalog: macCatalog(home), now: NOW, connected: ["chrome"], signals: { defaultBrowser: "com.microsoft.edgemac", running: [app("Google Chrome"), app("Brave Browser"), app("Microsoft Edge")], lastUsed } });
    assert.equal(both.primaryId, "edge");
    assert.equal(both.confidence, "default-and-in-use");
    const unreadable = identifyBrowser({ catalog: macCatalog(home), now: NOW, connected: ["chrome"], signals: { defaultBrowser: "com.microsoft.edgemac", running: null, lastUsed } });
    assert.equal(unreadable.primaryId, "edge");
    assert.equal(unreadable.confidence, "default-and-in-use");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a running Edge does not make a chrome name ambiguous, since Edge always reports edge", () => {
  const home = macHome(["chrome", "edge"]);
  try {
    const result = identifyBrowser({ catalog: macCatalog(home), now: NOW, connected: ["chrome"], signals: { defaultBrowser: "com.microsoft.edgemac", running: [app("Google Chrome"), app("Microsoft Edge")], lastUsed: { chrome: NOW - DAY, edge: NOW - DAY } } });
    assert.equal(result.primaryId, "chrome");
    assert.equal(result.confidence, "connected");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a name only one browser sends counts without a running signal; two connected browsers fall back to the signals", () => {
  const home = macHome(["chrome", "edge", "opera"]);
  try {
    const edge = identifyBrowser({ catalog: macCatalog(home), now: NOW, connected: ["edge"], signals: { defaultBrowser: "com.google.chrome", running: null, lastUsed: { chrome: NOW - DAY } } });
    assert.equal(edge.primaryId, "edge");
    assert.equal(edge.confidence, "connected");
    const two = identifyBrowser({ catalog: macCatalog(home), now: NOW, connected: ["edge", "opera"], signals: { defaultBrowser: "com.google.chrome", running: [app("Google Chrome")], lastUsed: { chrome: NOW - DAY } } });
    assert.equal(two.primaryId, "chrome");
    assert.equal(two.confidence, "default-and-in-use");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a connected browser that is not installed is not picked", () => {
  const home = macHome(["chrome", "brave"]);
  try {
    const result = identifyBrowser({ catalog: macCatalog(home), now: NOW, connected: ["edge"], signals: { defaultBrowser: "com.brave.browser", running: [app("Brave Browser")], lastUsed: { brave: NOW - DAY } } });
    assert.equal(result.primaryId, "brave");
    assert.equal(result.confidence, "default-and-in-use");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
