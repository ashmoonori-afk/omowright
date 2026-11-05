import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, existsSync, globSync, readdirSync, readlinkSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { PAGE_EVENT_NAMES, connectPipe, compactSnapshot, createAgentTabs } from "../src/index.js";
import { removeTreeSync } from "./fixtures/remove-tree.mjs";
import { windowsSystemTool } from "../src/owner-only.js";

function findHeadlessShell() {
  const home = process.env.HOME;
  const candidates = globSync(
    path.join(home, "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
  );
  if (candidates.length > 0) return candidates.sort().at(-1);
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(chrome)) return chrome;
  return null;
}

const SHELL = process.env.SHELL_BIN ?? findHeadlessShell();

function findFfmpeg() {
  const binary = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const candidates = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map(dir => path.join(dir, binary));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const { status, stdout } = spawnSync(candidate, ["-hide_banner", "-encoders"], { encoding: "utf8", timeout: 5000 });
    if (status !== 0 || !/^\s*V\S*\s+libvpx\s/m.test(stdout)) continue;
    const muxers = spawnSync(candidate, ["-hide_banner", "-muxers"], { encoding: "utf8", timeout: 5000 });
    if (muxers.status === 0 && /^\s*E\s+null\s/m.test(muxers.stdout)) return candidate;
  }
  return null;
}

const FFMPEG = findFfmpeg();

for (const mode of ["missing", "early-exit"]) {
  test(`page video ${mode} encoder rejects without crashing its host`, {
    skip: !SHELL && "no chromium binary found",
    timeout: 60000,
  }, () => {
    // The reported crash is in a Node host. Isolate it so an uncaught rejection
    // fails this assertion under either test runner instead of killing the suite.
    const result = spawnSync("node", [
      fileURLToPath(new URL("./fixtures/video-failure-host.mjs", import.meta.url)), mode, SHELL,
    ], { encoding: "utf8", timeout: 45000 });
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
    const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.deepEqual(receipt, { mode, error: "VideoRecordingError", closed: true });
  });
}

// The package entry must finalize real screencast frames into a decodable clip.
// Dangling bundled imports or missing encoder process helpers break this boundary.
test("page video start and stop write a playable clip through the package entry", {
  skip: !SHELL ? "no chromium binary found" : !FFMPEG && "no ffmpeg on PATH with the libvpx encoder and null muxer",
  timeout: 60000,
}, async () => {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-video-"));
  const connection = await connectPipe({
    browserPath: SHELL,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
    storageRoot: ud,
  });
  const originalPath = process.env.PATH;
  try {
    // Make the recorder's bare `ffmpeg` command use the qualified PATH binary.
    const encoderDir = path.join(ud, "encoder");
    mkdirSync(encoderDir);
    copyFileSync(FFMPEG, path.join(encoderDir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"));
    process.env.PATH = `${encoderDir}${path.delimiter}${originalPath ?? ""}`;
    const page = await connection.newTab("about:blank");
    const video = page.video();
    await video.start({ path: "capture/raw.webm", size: { width: 320, height: 240 } });
    await page.evaluate(() => {
      document.body.style.background = "red";
      document.body.textContent = "Recording a page action";
    });
    await video.stop({ path: "clips/finished.webm" });
    const clip = path.join(ud, "clips/finished.webm");
    assert.equal(await video.path(), clip);
    assert.ok(statSync(clip).size > 0, "stop writes a non-empty clip");
    execFileSync(FFMPEG, ["-v", "error", "-i", clip, "-f", "null", "-"], { stdio: "pipe" });
    await video.saveAs("copies/saved.webm");
    assert.deepEqual(readFileSync(path.join(ud, "copies/saved.webm")), readFileSync(clip));
    await video.delete();
    assert.equal(existsSync(clip), false);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await connection.close();
    removeTreeSync(ud);
  }
});

// Public event contract: subscription must deliver browser console calls, not merely accept the event name.
// This fails if Runtime capture or page event forwarding is removed; console.logs() cannot prove delivery.
test("console events stream with type and text and respect page scope and off", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-console-"));
  const browser = await connectPipe({ browserPath: SHELL, browserArgs: ["--headless", `--user-data-dir=${ud}`], storageRoot: ud });
  try {
    const page = await browser.newTab("about:blank");
    const other = await browser.newTab("about:blank");
    const messages = [];
    const listener = message => messages.push([message.type(), message.text()]);
    page.on("console", listener);
    const first = page.waitForEvent("console", { timeout: 2000 });
    await other.evaluate("console.log('other-page')");
    await page.evaluate("console.warn('first', 42)");
    const message = await first;
    assert.equal(message.type(), "warning");
    assert.equal(message.text(), "first 42");
    assert.deepEqual(messages, [["warning", "first 42"]]);
    page.off("console", listener);
    const second = page.waitForEvent("console", { timeout: 2000 });
    await page.evaluate("console.error('second')");
    assert.equal((await second).text(), "second");
    assert.deepEqual(messages, [["warning", "first 42"]]);
    const onLoad = page.waitForEvent("console", { timeout: 5000 });
    await page.goto("data:text/html,<script>console.log('navigated')</script><p>ok</p>", { waitUntil: "load" });
    assert.equal((await onLoad).text(), "navigated");
  } finally {
    await browser.close();
    removeTreeSync(ud);
  }
});

// Public CSS contract across the actual browser boundary. The three query paths (count/all/actions)
// must agree; a DOM-only mock would hide the failure. No test-only production hook is needed.
test("CSS locators pierce nested open shadows for collections and actions", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-shadow-"));
  const browser = await connectPipe({ browserPath: SHELL, browserArgs: ["--headless", `--user-data-dir=${ud}`], storageRoot: ud });
  try {
    const page = await browser.newTab("about:blank");
    await page.evaluate(() => {
      document.body.innerHTML = '<div id="host"></div><button class="item">Light</button><div id="closed"></div>';
      const shadow = document.querySelector("#host").attachShadow({ mode: "open" });
      shadow.innerHTML = '<button id="inside-shadow" class="item">Shadow</button><div id="nested"></div>';
      shadow.querySelector("#nested").attachShadow({ mode: "open" }).innerHTML = '<button class="item" data-note="a > b">Nested</button>';
      document.querySelector("#closed").attachShadow({ mode: "closed" }).innerHTML = '<button class="item">Closed</button>';
      shadow.querySelector("button").onclick = () => { document.body.dataset.clicked = "shadow"; };
    });
    assert.equal(await page.locator("#inside-shadow").count(), 1);
    assert.equal(await page.locator(".item").count(), 3);
    assert.deepEqual(await page.locator(".item").evaluateAll(nodes => nodes.map(node => node.textContent)), ["Light", "Shadow", "Nested"]);
    assert.equal(await page.locator("#host").locator("#nested").locator(".item").textContent(), "Nested");
    assert.equal(await page.locator('#host #nested > [data-note="a > b"]').textContent(), "Nested");
    assert.equal(await page.locator("#host").locator(":scope > button").textContent(), "Shadow");
    assert.equal(await page.locator("#closed .item").count(), 0);
    await page.locator("#inside-shadow").click();
    assert.equal(await page.evaluate("document.body.dataset.clicked"), "shadow");
    await page.evaluate(() => {
      document.body.innerHTML = '<div id="a"><span>Scoped</span><section></section></div>';
    });
    for (const shadow of [false, true]) {
      if (shadow) await page.evaluate(() => document.querySelector("#a section").attachShadow({ mode: "open" }));
      assert.equal(await page.locator("#a").locator("body > #a > span").count(), 0);
      assert.equal(await page.locator("#a").locator("body span").count(), 0);
      assert.equal(await page.locator("#a").locator(":scope > span").textContent(), "Scoped");
    }
  } finally {
    await browser.close();
    removeTreeSync(ud);
  }
});

// Locator queries must work beyond the engine's call-argument limit, both without shadows
// and when a large open root is present. Small DOM fixtures cannot catch argument spreading.
test("CSS locators query large light and shadow DOMs without argument overflow", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-large-dom-"));
  const browser = await connectPipe({ browserPath: SHELL, browserArgs: ["--headless", `--user-data-dir=${ud}`], storageRoot: ud });
  try {
    const page = await browser.newTab("about:blank");
    await page.evaluate(() => {
      document.body.innerHTML = "<i></i>".repeat(150000) + '<button class="large-target">Light</button>';
    });
    assert.equal(await page.locator(".large-target").count(), 1);
    assert.equal(await page.locator(".large-target").textContent(), "Light");
    await page.evaluate(() => {
      const host = document.body.appendChild(document.createElement("section"));
      host.attachShadow({ mode: "open" }).innerHTML = "<i></i>".repeat(150000) + '<button class="large-target">Shadow</button>';
    });
    assert.equal(await page.locator(".large-target").count(), 2);
    assert.deepEqual(await page.locator(".large-target").evaluateAll(nodes => nodes.map(node => node.textContent)), ["Light", "Shadow"]);
    assert.equal(await page.locator(".large-target").last().textContent(), "Shadow");
  } finally {
    await browser.close();
    removeTreeSync(ud);
  }
});

// The shadow-free hot path must use native matching, not call matches() on each DOM element.
// Count calls instead of measuring elapsed time, so host load cannot make the regression pass.
test("shadow-free CSS queries keep selector matching native", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-native-query-"));
  const browser = await connectPipe({ browserPath: SHELL, browserArgs: ["--headless", `--user-data-dir=${ud}`], storageRoot: ud });
  try {
    const page = await browser.newTab("about:blank");
    await page.evaluate(() => { document.body.innerHTML = '<section id="scope">' + '<i class="item"></i>'.repeat(1000) + '<span id="target">Native</span></section>'; });
    const frameId = page.mainFrame().frameId;
    await page.evaluateInFrame(frameId, () => {
      window.queryAudit = { calls: 0, original: Element.prototype.matches };
      Element.prototype.matches = function(selector) {
        window.queryAudit.calls++;
        return window.queryAudit.original.call(this, selector);
      };
    });
    try {
      assert.equal(await page.locator("#target").count(), 1);
      assert.equal(await page.locator("#scope").locator(".item").count(), 1000);
      assert.equal(await page.evaluateInFrame(frameId, () => window.queryAudit.calls), 0);
    } finally {
      await page.evaluateInFrame(frameId, () => {
        Element.prototype.matches = window.queryAudit.original;
        delete window.queryAudit;
      });
    }
  } finally {
    await browser.close();
    removeTreeSync(ud);
  }
});

const FIXTURE_PAGE = "<!doctype html><title>Example Domain</title><main><h1>Example Domain</h1>"
  + "<p>A local page for the pipe transport test, with enough text for the content readiness probe.</p>"
  + "<a href=\"#more\">More information</a></main>";

async function serveFixturePage() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(FIXTURE_PAGE);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

// Linux reads /proc directly (lsof is often absent there); Windows has no lsof, so it asks the TCP stack
// through Get-NetTCPConnection (IPv4 and IPv6, locale-independent); macOS lsof exits 1 when nothing matches.
function listeningTcpSockets(pid) {
  if (process.platform === "win32") {
    // No match is reported as an ObjectNotFound error: that alone means "nothing listens". Any other error, or a
    // missing cmdlet, fails the call instead of reading as an empty list.
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$found = Get-NetTCPConnection -State Listen -OwningProcess ${pid} -ErrorAction SilentlyContinue -ErrorVariable failures`,
      "$other = @($failures | Where-Object { $_.CategoryInfo.Category -ne 'ObjectNotFound' })",
      "if ($other.Count -gt 0) { [Console]::Error.WriteLine(($other | Out-String)); exit 2 }",
      "$found | ForEach-Object { \"$($_.LocalAddress):$($_.LocalPort)\" }",
      "exit 0",
    ].join("; ");
    return execFileSync(windowsSystemTool("WindowsPowerShell\\v1.0\\powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
  }
  if (process.platform !== "linux") {
    try {
      return execFileSync("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", String(pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    } catch (error) {
      assert.equal(error.status, 1, `lsof failed: ${error.message}`);
      return [];
    }
  }
  const inodes = new Set();
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    let target = "";
    try { target = readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; } // fd closed since readdir
    const match = /^socket:\[(\d+)\]$/.exec(target);
    if (match) inodes.add(match[1]);
  }
  const listening = [];
  for (const table of ["tcp", "tcp6"]) {
    for (const row of readFileSync(`/proc/${pid}/net/${table}`, "utf8").trim().split("\n").slice(1)) {
      const cols = row.trim().split(/\s+/);
      if (cols[3] === "0A" && inodes.has(cols[9])) listening.push(`${table} ${cols[1]}`);
    }
  }
  return listening;
}

test("pipe transport drives Chromium with zero listening TCP ports", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-test-"));
  const fixture = await serveFixturePage();
  const connection = await connectPipe({
    browserPath: SHELL,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
    storageRoot: ud,
  });
  try {
    const pid = connection.browserProcess?.pid;
    assert.ok(pid > 0, "browser process pid");

    assert.deepEqual(listeningTcpSockets(pid), [], "browser must not listen on any TCP port");

    const page = (await createAgentTabs(connection).create("about:blank")).page;
    await page.goto(fixture.url);
    assert.equal(await page.title(), "Example Domain");
    // goto() resolves on the content probe; the committed URL lands with the main-frame
    // navigation event, which can trail the probe under load. Wait for that state.
    await page.waitForURL(fixture.url, { timeout: 10_000 });
    assert.equal(page.url(), fixture.url);

    const snapshot = await page.snapshot();
    const tree = compactSnapshot(snapshot);
    assert.ok(tree.includes('heading "Example Domain"'));
    assert.ok(tree.includes("[ref=e1]"));

    const fullBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
    const compactBytes = Buffer.byteLength(tree, "utf8");
    assert.ok(compactBytes < fullBytes, "compact tree smaller than full snapshot");
  } finally {
    await connection.close();
    await new Promise(resolve => fixture.server.close(resolve));
    removeTreeSync(ud);
  }
});

// Contract: a stale ref is re-found only when its role and name were unique in the snapshot and
// are unique now. With two look-alike buttons re-rendered in a new order, the action must fail
// instead of acting on the other row; a unique button that was re-rendered is still found.
test("stale ref recovery refuses look-alike elements and keeps unique ones", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const html = `<!doctype html><title>rows</title><ul id="rows"><li>Alpha <button data-id="a">Delete</button></li><li>Beta <button data-id="b">Delete</button></li></ul><button id="save">Save</button><p id="log"></p>
<script>
document.addEventListener("click", (event) => { const id = event.target.dataset?.id ?? event.target.id; if (id) document.getElementById("log").textContent += id + ";"; });
window.rerender = () => {
  const rows = document.getElementById("rows");
  rows.innerHTML = '<li>Beta <button data-id="b">Delete</button></li><li>Alpha <button data-id="a">Delete</button></li>';
  document.getElementById("save").replaceWith(Object.assign(document.createElement("button"), { id: "save", textContent: "Save" }));
};
</script>`;
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-stale-"));
  const browser = await connectPipe({ browserPath: SHELL, browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`], storageRoot: ud });
  try {
    const page = await browser.newTab(`data:text/html,${encodeURIComponent(html)}`);
    const { refs } = await page.snapshot();
    const refOf = (name, nth) => Object.entries(refs).filter(([, meta]) => meta.role === "button" && meta.name === name)[nth][0];
    const alphaDelete = refOf("Delete", 0);
    const save = refOf("Save", 0);
    await page.evaluate("window.rerender()");
    await assert.rejects(page.locator(alphaDelete).click({ timeout: 2000 }));
    await page.locator(save).click({ timeout: 5000 });
    assert.equal(await page.evaluate("document.getElementById('log').textContent"), "save;");
  } finally {
    await browser.close();
    removeTreeSync(ud);
  }
});

// Public snapshot contract: identities survive value/state and sibling changes; a renamed or
// replaced element gets a new ref. This also exercises the allocator without changing recovery.
test("snapshot refs survive fills and insertions but not identity changes", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-refs-"));
  const browser = await connectPipe({ browserPath: SHELL, browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`], storageRoot: ud });
  try {
    const page = await browser.newTab('data:text/html,<label>Name<input></label><button>Save</button>');
    const before = await page.snapshot();
    const refOf = (snapshot, name) => Object.entries(snapshot.refs).find(([, meta]) => meta.name === name)[0];
    const name = refOf(before, "Name");
    const save = refOf(before, "Save");
    await page.locator(name).fill("Ada");
    await page.evaluate("document.body.prepend(Object.assign(document.createElement('button'), {textContent:'Earlier'}))");
    const after = await page.snapshot();
    assert.equal(refOf(after, "Name"), name);
    assert.equal(refOf(after, "Save"), save);
    await page.evaluate("document.querySelector('button:last-of-type').textContent = 'Submit'");
    const renamed = await page.snapshot();
    assert.notEqual(refOf(renamed, "Submit"), save);
    assert.ok(!renamed.refs[save]);
    await page.locator(name).fill("Grace");
    assert.equal(await page.evaluate("document.querySelector('input').value"), "Grace");
  } finally {
    await browser.close();
    removeTreeSync(ud);
  }
});

// Protect the observable delta, baseline, navigation and byte-size contracts at the real page
// boundary. Existing snapshots only assert full trees, so ignoring diff would otherwise pass.
test("snapshot diffs describe form changes and reset on navigation", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-diff-"));
  const browser = await connectPipe({ browserPath: SHELL, browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`], storageRoot: ud });
  const html = `<main>
<section role="region" aria-label="Notice" id="banner"><button>Dismiss</button></section>
<form>${[
    ["Full name", "Your first and last name"],
    ["Email address", "Where to send your confirmation"],
    ["Organization", "Your company or institution"],
    ["Job title", "Your role at the organization"],
    ["Phone number", "Include your country code"],
    ["Street address", "Street and building number"],
    ["City", "City or town"],
    ["State or region", "State, province or region"],
    ["Postal code", "Your local postal code"],
    ["Country", "Your country of residence"],
    ["Billing reference", "Purchase order or billing identifier"],
    ["Special requests", "Dietary or accessibility requirements"],
  ].map(([name, hint], i) => `<label>${name}<input name="field${i}" placeholder="${hint}"></label>`).join("")}
<button type="button" onclick="document.getElementById('extra').hidden=false">More</button>
<section id="extra" hidden><input aria-label="Extra details"></section></form></main>`;
  const url = `data:text/html,${encodeURIComponent(html)}`;
  try {
    const page = await browser.newTab(url);
    const first = await page.snapshot({ diff: true });
    assert.equal(first.full, true);
    assert.equal(first.reason, "no-baseline");
    const refOf = (snapshot, name) => Object.entries(snapshot.refs).find(([, meta]) => meta.name === name)[0];
    const fieldName = "Full name";
    const field = refOf(first, fieldName);
    const more = refOf(first, "More");
    await page.locator(field).fill("Ada");
    const filled = await page.snapshot({ diff: true });
    assert.equal(filled.full, false);
    assert.deepEqual(filled.diff.added, []);
    assert.deepEqual(filled.diff.removed, []);
    assert.deepEqual(filled.diff.changed.map(node => node.ref), [field]);
    assert.ok(filled.diff.changed[0].tree.includes('"Ada"'));
    assert.equal(filled.diff.focused, field);
    await page.locator(more).click();
    const opened = await page.snapshot({ diff: true });
    assert.equal(opened.full, false, JSON.stringify(opened));
    assert.equal(opened.diff.added.length, 1);
    const extra = opened.diff.added[0].ref;
    assert.match(opened.diff.added[0].tree, /Extra details/);
    assert.ok(opened.diff.changed.some(node => node.ref === field));
    assert.equal(opened.diff.focused, more);
    const full = await page.snapshot({ diff: false });
    assert.equal(refOf(full, fieldName), field);
    assert.equal(refOf(full, "Extra details"), extra);
    assert.deepEqual(await page.snapshot({ diff: true }), {
      diff: { added: [], changed: [], removed: [], focused: more }, full: false,
    });
    const banner = refOf(full, "Notice");
    const dismiss = refOf(full, "Dismiss");
    await page.evaluate("document.getElementById('banner').remove()");
    const removed = await page.snapshot({ diff: true });
    assert.equal(removed.full, false);
    assert.deepEqual(removed.diff.removed, [banner, dismiss]);
    assert.deepEqual(removed.diff.added, []);
    const other = await browser.newTab(url);
    assert.equal((await other.snapshot({ diff: true })).reason, "no-baseline");
    await page.goto(url);
    const navigated = await page.snapshot({ diff: true });
    assert.equal(navigated.full, true);
    assert.equal(navigated.reason, "navigation");
    await page.locator(refOf(navigated, "More")).click();
    const stepBaseline = await page.snapshot();
    await page.locator(refOf(navigated, fieldName)).fill("Ada");
    await page.locator(refOf(navigated, "More")).click();
    const step = await page.snapshot({ diff: true });
    assert.equal(step.full, false);
    const bytes = Buffer.byteLength(JSON.stringify(step));
    const fullBytes = Buffer.byteLength(stepBaseline.tree);
    assert.ok(bytes < fullBytes / 10, `diff=${bytes} full tree=${fullBytes}`);
    console.info(`snapshot fill-and-click: diff=${bytes} full tree=${fullBytes}`);
    await page.goto('data:text/html,<button>Go</button>');
    await page.snapshot();
    await page.evaluate("document.querySelector('button').disabled = true");
    const larger = await page.snapshot({ diff: true });
    assert.equal(larger.full, true);
    assert.equal(larger.reason, "diff-larger-than-full");
    assert.match(larger.tree, /\[disabled\]/);
    assert.equal((await page.snapshot({ diff: true, interactive: true })).reason, "options-changed");
    await page.goto('data:text/html,<h1>Before</h1><button>Go</button>');
    await page.snapshot();
    await page.evaluate("document.querySelector('h1').textContent = 'After'");
    const text = await page.snapshot({ diff: true });
    assert.equal(text.full, true);
    assert.equal(text.reason, "unreferenced-content");
    assert.match(text.tree, /After/);
  } finally {
    await browser.close();
    removeTreeSync(ud);
  }
});

test("JavaScript dialogs are auto-accepted and surfaced as events", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-dialog-test-"));
  const connection = await connectPipe({
    browserPath: SHELL,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
    storageRoot: ud,
  });
  try {
    const page = (await createAgentTabs(connection).create("about:blank")).page;
    const events = [];
    page.on("dialog", dialog => events.push(dialog));

    await page.evaluate("alert('hello')");
    assert.equal(await page.evaluate("confirm('proceed?')"), true, "confirm() auto-accepts to true");
    assert.equal(await page.evaluate("prompt('name?', 'dflt')"), "", "prompt() auto-accepts to empty string");

    assert.equal(events.length, 3, "every dialog surfaces as an event");
    assert.deepEqual(events.map(d => d.type()), ["alert", "confirm", "prompt"]);
    assert.equal(events[0].message(), "hello");
    assert.equal(events[2].defaultValue(), "dflt");

    const t0 = Date.now();
    await page.goto("data:text/html,<script>alert('during load')</script><main><h1>Substantial text content for the readiness probe</h1><a href='https://example.com'>link</a></main>");
    assert.ok(Date.now() - t0 < 15000, "goto with a load-time dialog completes via the content probe");
    assert.equal(await page.evaluate("document.readyState"), "complete");
  } finally {
    await connection.close();
    removeTreeSync(ud);
  }
});

// Contract: goto resolves on a fully loaded page that is short or is a frameset. Before this,
// the content probe kept such pages "sparse" and goto threw after its whole 30 s budget.
test("goto resolves on a loaded sparse page and on a frameset page", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const pages = {
    "/sparse": "<!doctype html><title>sparse</title><h1>Done</h1>",
    "/frameset": "<!doctype html><title>frameset</title><frameset cols=\"50%,50%\"><frame src=\"/left\"><frame src=\"/right\"></frameset>",
    "/left": "<!doctype html><body>LEFT</body>",
    "/right": "<!doctype html><body>RIGHT</body>",
  };
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(pages[request.url] ?? "");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-sparse-"));
  const browser = await connectPipe({ browserPath: SHELL, browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`], storageRoot: ud });
  try {
    const page = await browser.newTab("about:blank");
    for (const route of ["/sparse", "/frameset"]) {
      const started = Date.now();
      await page.goto(`${origin}${route}`);
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 8000, `${route} took ${elapsed} ms`);
      assert.equal(await page.title(), route.slice(1));
    }
    assert.ok((await page.snapshot()).tree.length > 0);
  } finally {
    await browser.close();
    removeTreeSync(ud);
    await new Promise(resolve => server.close(resolve));
  }
});

// Navigation readiness must include fetch-driven hydration, but a background fetch must
// not turn the bounded readiness wait into a network-idle wait.
test("goto snapshots hydrated content and bounds never-ending fetches", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const timers = new Set();
  const server = createServer((request, response) => {
    if (request.url === "/pending") return;
    if (request.url === "/content" || request.url === "/text") {
      // This is server latency in the application being tested, not a test wait.
      const timer = setTimeout(() => {
        timers.delete(timer);
        response.end("<main><h1>Hydrated content</h1><button>Continue</button></main>");
      }, request.url === "/content" ? 500 : 200);
      timers.add(timer);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>hydration</title>
<style>@keyframes reveal { from { opacity: 0.99 } to { opacity: 1 } }</style>
<body><a href="#main">Skip to content</a>
<script>
document.addEventListener("DOMContentLoaded", async () => {
  ${request.url === "/forever" ? 'fetch("/pending");' : `
  const content = await (await fetch("/content")).text();
  const link = document.querySelector("a");
  link.addEventListener("animationend", async () => {
    document.body.insertAdjacentHTML("beforeend", content);
    const heading = document.querySelector("h1").firstChild;
    await fetch("/text");
    heading.data = "Hydrated and settled";
    window.lastMutation = performance.now();
  }, { once: true });
  // A real rendering event separates the fetch from committing the hydrated UI.
  link.style.animation = "reveal 200ms";
  `}
});
</script>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-hydration-"));
  const browser = await connectPipe({ browserPath: SHELL, browserArgs: ["--headless", `--user-data-dir=${ud}`], storageRoot: ud });
  try {
    const page = await browser.newTab("about:blank");
    await page.goto(`${origin}/hydrate`);
    assert.match(compactSnapshot(await page.snapshot()), /heading "Hydrated and settled"/);
    assert.ok(await page.evaluate(() => performance.now() - window.lastMutation >= 500), "body mutations settled for 500 ms");
    const started = Date.now();
    await page.goto(`${origin}/forever`);
    const elapsed = Date.now() - started;
    // Navigation/CDP overhead is outside the 1,500 ms request budget.
    assert.ok(elapsed < 2500, `never-ending fetch took ${elapsed} ms`);
    assert.match(compactSnapshot(await page.snapshot()), /Skip to content/);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    await browser.close();
    removeTreeSync(ud);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

// Public locator contract (#129): getByRole, getByText and getByLabel see elements inside open
// shadow roots, nested ones included, and never inside closed roots. Count and action resolution
// run separate in-page queries, so both are exercised against a real browser.
test("role, text and label locators pierce nested open shadows but not closed ones", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-shadow-role-"));
  const browser = await connectPipe({ browserPath: SHELL, browserArgs: ["--headless", `--user-data-dir=${ud}`], storageRoot: ud });
  try {
    const page = await browser.newTab("about:blank");
    await page.evaluate(() => {
      document.body.innerHTML = '<button>Save light</button><div id="host"></div><div id="closed"></div>';
      const shadow = document.querySelector("#host").attachShadow({ mode: "open" });
      shadow.innerHTML = '<button>Save shadow</button><p>Shadow paragraph</p>'
        + '<label for="email">Shadow email</label><input id="email"><div id="nested"></div>';
      shadow.querySelector("button").onclick = () => { document.body.dataset.clicked = "shadow"; };
      shadow.querySelector("#nested").attachShadow({ mode: "open" }).innerHTML = '<button aria-labelledby="nested-name">x</button>'
        + '<span id="nested-name">Save nested</span><p>Nested paragraph</p><label>Nested name <input></label>';
      document.querySelector("#closed").attachShadow({ mode: "closed" }).innerHTML = '<button>Save closed</button>'
        + '<p>Closed paragraph</p><label for="c">Closed email</label><input id="c">';
    });

    assert.equal(await page.getByRole("button", { name: "Save shadow" }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Save nested", exact: true }).count(), 1);
    assert.equal(await page.getByRole("button", { name: /^Save/ }).count(), 3);
    assert.equal(await page.getByRole("button", { name: "Save closed" }).count(), 0);
    await page.getByRole("button", { name: "Save shadow" }).click();
    assert.equal(await page.evaluate("document.body.dataset.clicked"), "shadow");

    assert.equal(await page.getByText("Shadow paragraph").textContent(), "Shadow paragraph");
    assert.equal(await page.getByText("Nested paragraph").count(), 1);
    assert.equal((await page.locator("#host").locator("text:Nested paragraph").all()).length, 1);
    assert.equal(await page.getByText("Closed paragraph").count(), 0);

    await page.getByLabel("Shadow email").fill("shadow@example.com");
    assert.equal(await page.evaluate("document.querySelector('#host').shadowRoot.querySelector('#email').value"), "shadow@example.com");
    assert.equal(await page.getByLabel("Nested name").count(), 1);
    assert.equal(await page.getByLabel("Closed email").count(), 0);

    // 150k elements in one shadow scope exceed the engine's argument limit, so a traversal that
    // spreads a NodeList into push() throws RangeError here instead of matching.
    await page.evaluate(() => {
      const bulk = document.createElement("div");
      bulk.innerHTML = "<i></i>".repeat(150000) + "<p>Bulk paragraph</p>";
      document.querySelector("#host").shadowRoot.querySelector("#nested").shadowRoot.append(bulk);
    });
    assert.equal(await page.getByText("Bulk paragraph").count(), 1);
  } finally {
    await browser.close();
    removeTreeSync(ud);
  }
});

async function withPipeBrowser(prefix, run) {
  const ud = mkdtempSync(path.join(tmpdir(), prefix));
  const browser = await connectPipe({ browserPath: SHELL, browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`], storageRoot: ud });
  try {
    await run(browser);
  } finally {
    await browser.close();
    removeTreeSync(ud);
  }
}

// Public API contract: page.on/off/waitForEvent accept exactly the exported PAGE_EVENT_NAMES, so a typo or an
// unsupported Playwright event fails loudly instead of subscribing to something that never fires.
test("page events refuse unknown names and list the supported ones", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  await withPipeBrowser("omowright-page-event-names-", async browser => {
    const page = await browser.newTab("about:blank");
    for (const name of PAGE_EVENT_NAMES) page.on(name, () => {})();
    const unknown = error => error instanceof TypeError
      && PAGE_EVENT_NAMES.every(name => error.message.includes(name));
    assert.throws(() => page.on("pageerorr", () => {}), error => unknown(error) && error.message.includes("pageerorr"));
    assert.throws(() => page.off("worker", () => {}), unknown);
    await assert.rejects(page.waitForEvent("requestfailed", { timeout: 1000 }), unknown);
  });
});

// Public event contract: pageerror delivers uncaught page exceptions as Errors, never one thrown before the
// subscription (Runtime.enable replays those), and Runtime (which pages can detect) runs only while a listener
// exists. Each synchronous throw is followed by a later timer in the same evaluate, so the browser has reported
// it on the raw CDP stream, if Runtime was on, before evaluate resolves.
test("pageerror delivers uncaught exceptions only while subscribed", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  await withPipeBrowser("omowright-pageerror-", async browser => {
    const page = await browser.newTab("about:blank");
    const sessionId = await page.resolveSessionId();
    const reported = [];
    page.cdp.on("Runtime.exceptionThrown", (event, meta) => {
      if (meta.sessionId === sessionId) reported.push(event.exceptionDetails.exception?.description?.split("\n")[0]);
    });
    const throwLater = expression => page.evaluate(`setTimeout(() => { ${expression} }); new Promise(resolve => setTimeout(resolve))`);

    await throwLater("throw new TypeError('before')");
    assert.deepEqual(reported, [], "Runtime stays off without a pageerror listener");

    const errors = [];
    const listener = error => errors.push(error);
    page.on("pageerror", listener);
    const first = page.waitForEvent("pageerror", { timeout: 5000 });
    await throwLater("throw new TypeError('first')");
    await first;
    const rejected = page.waitForEvent("pageerror", { timeout: 5000 });
    await throwLater("Promise.reject(new RangeError('rejected'))");
    await rejected;
    assert.deepEqual(errors.map(error => [error instanceof Error, error.name, error.message]),
      [[true, "TypeError", "first"], [true, "RangeError", "rejected"]], "only exceptions thrown while subscribed are delivered");
    assert.match(errors[0].stack, /^TypeError: first\n\s+at /);

    page.off("pageerror", listener);
    await throwLater("throw new TypeError('after')");
    assert.equal(errors.length, 2);
    assert.ok(!reported.includes("TypeError: after"), "Runtime is disabled once the last listener leaves");
  });
});

// Public event contract: close fires for page.close() and also when the tab goes away without it (window.close(), the
// user, another client), and the page is disposed with it instead of failing later on a lost session.
test("close fires for page.close() and when a page closes itself", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  await withPipeBrowser("omowright-page-close-", async browser => {
    const closing = await browser.newTab("about:blank");
    const closed = closing.waitForEvent("close", { timeout: 10000 });
    await closing.close();
    await closed;

    const page = await browser.newTab("about:blank");
    const selfClosed = page.waitForEvent("close", { timeout: 10000 });
    await page.evaluate("window.close()");
    await selfClosed;
    await assert.rejects(page.evaluate("1"), /disposed/);
  });
});
