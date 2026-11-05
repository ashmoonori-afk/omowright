import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, globSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { connectPipe, createAgentTabs, createCua, createCaptcha } from "../src/index.js";
import { removeTreeSync } from "./fixtures/remove-tree.mjs";

function findHeadlessShell() {
  const candidates = globSync(
    path.join(process.env.HOME, "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
  );
  if (candidates.length > 0) return candidates.sort().at(-1);
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(chrome)) return chrome;
  return null;
}

const SHELL = process.env.SHELL_BIN ?? findHeadlessShell();

const FIXTURE = `data:text/html,${encodeURIComponent(`<!DOCTYPE html>
<html><body style="margin:0;font-family:monospace">
<div id="captcha-box" style="position:absolute;left:40px;top:40px;width:200px;height:60px;border:2px solid #888;display:flex;align-items:center;gap:8px;padding:4px">
  <input type="checkbox" id="cb" style="width:24px;height:24px"><span>I'm not a robot</span>
</div>
<button id="btn" style="position:absolute;left:40px;top:140px;width:120px;height:40px">Click me</button>
<input id="name" style="position:absolute;left:40px;top:200px;width:200px;height:30px" type="text">
<div id="slider" style="position:absolute;left:40px;top:280px;width:300px;height:20px;background:#ddd">
  <div id="handle" style="position:absolute;left:0;top:0;width:20px;height:20px;background:#36c"></div>
</div>
<div id="captcha-text" style="position:absolute;left:40px;top:340px;width:220px;height:70px;font-size:44px;font-weight:bold;letter-spacing:8px;background:#fff;color:#000">XK7M2</div>
<div style="height:2000px"></div>
<div>bottom marker with enough text to pass the readiness probe</div>
<script>
window.__log = [];
document.getElementById('btn').addEventListener('click', () => window.__log.push('btn-clicked'));
document.getElementById('cb').addEventListener('change', e => window.__log.push('cb-' + e.target.checked));
const handle = document.getElementById('handle');
let dragging = false;
handle.addEventListener('mousedown', () => { dragging = true; window.__log.push('drag-start'); });
window.addEventListener('mousemove', e => {
  if (!dragging) return;
  const track = document.getElementById('slider').getBoundingClientRect();
  const x = Math.max(0, Math.min(280, e.clientX - track.left - 10));
  handle.style.left = x + 'px';
  window.__log.push('drag-x-' + Math.round(x));
});

window.addEventListener('mouseup', () => { if (dragging) window.__log.push('drag-end'); dragging = false; });
</script></body></html>`)}`;

async function launch() {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-cua-test-"));
  const connection = await connectPipe({
    browserPath: SHELL,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`, "about:blank"],
    storageRoot: ud,
  });
  return { connection, cleanup: async () => { await connection.close(); removeTreeSync(ud); } };
}

// CDP events can overtake one another across SerialEmitter dispatches. Hold the
// first page listener until targetCreated, reproducing two attached agent tabs.
test("popup delivery survives targetCreated before the second page windowOpen handler", { skip: !SHELL, timeout: 30000 }, async () => {
  const { connection, cleanup } = await launch();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const offWindow = connection.cdp.on("Page.windowOpen", () => gate);
  const offTarget = connection.cdp.on("Target.targetCreated", ({ targetInfo }) => {
    if (targetInfo.openerId) release();
  });
  try {
    await connection.newTab();
    const opener = await connection.newTab();
    for (const name of ["second-tab-popup-1", "second-tab-popup-2"]) {
      const opened = opener.waitForEvent("popup", { timeout: 10000 });
      const checked = opened.then(async popup => {
        assert.equal(await popup.evaluate("window.name"), name);
        assert.equal(popup.popupMetadata.windowName, name);
        assert.ok(createAgentTabs(connection).get(popup.targetId));
      });
      await opener.evaluate(`window.open("about:blank", ${JSON.stringify(name)}); void 0`);
      await checked;
    }
  } finally {
    release(); offWindow(); offTarget(); await cleanup();
  }
});

for (const kind of ["user tab with listener", "agent tab without listener"]) {
  test(`popup adoption excludes ${kind}`, { skip: !SHELL, timeout: 15000 }, async () => {
    const { connection, cleanup } = await launch();
    const user = kind.startsWith("user");
    let windowDone;
    const windowHandled = new Promise(resolve => { windowDone = resolve; });
    // Force windowOpen-first here so the old implementation reliably adopts.
    const offTargetGate = connection.cdp.on("Target.targetCreated", async ({ targetInfo }) => {
      if (targetInfo.openerId) await windowHandled;
    });
    try {
      const opener = user
        ? await connection.attachPage((await connection.listTargets()).find(t => t.type === "page").id)
        : await connection.newTab();
      const offPopup = user ? opener.on("popup", () => {}) : () => {};
      const attaching = [];
      const attach = connection.attachPage.bind(connection);
      connection.attachPage = id => {
        const operation = attach(id);
        attaching.push(operation);
        return operation;
      };
      const offWindow = connection.cdp.on("Page.windowOpen", () => windowDone());
      let targetDone;
      const targetHandled = new Promise(resolve => { targetDone = resolve; });
      const offTarget = connection.cdp.on("Target.targetCreated", ({ targetInfo }) => {
        if (targetInfo.openerId === opener.targetId) targetDone(targetInfo.targetId);
      });
      await opener.evaluate('window.open("about:blank", "unowned-popup"); void 0');
      const targetId = await targetHandled;
      await Promise.all(attaching);
      assert.equal(createAgentTabs(connection).get(targetId), null, "unsubscribed or user popups must remain unowned");
      assert.equal(attaching.length, 0, "no popup domains or viewport may be enabled");
      offWindow(); offTarget(); offPopup();
    } finally {
      windowDone(); offTargetGate(); await cleanup();
    }
  });
}

test("popup destroyed before attach rejects its waiter with the lifecycle error", { skip: !SHELL, timeout: 15000 }, async () => {
  const { connection, cleanup } = await launch();
  let windowDone;
  const windowHandled = new Promise(resolve => { windowDone = resolve; });
  const offGate = connection.cdp.on("Target.targetCreated", async ({ targetInfo }) => {
    if (targetInfo.openerId) await windowHandled;
  });
  try {
    const opener = await connection.newTab();
    const offWindow = connection.cdp.on("Page.windowOpen", () => windowDone());
    const attach = connection.attachPage.bind(connection);
    connection.attachPage = async id => {
      if (id === opener.targetId) return attach(id);
      const destroyed = new Promise(resolve => {
        const off = connection.cdp.on("Target.targetDestroyed", info => {
          if (info.targetId === id) { off(); resolve(); }
        });
      });
      await opener.evaluate('window.closingPopup.eval("window.close()"); void 0');
      await destroyed;
      return attach(id);
    };
    const checked = assert.rejects(opener.waitForEvent("popup", { timeout: 2000 }), error => {
      assert.doesNotMatch(error.message, /Timed out waiting/);
      assert.match(error.message, /closed|target|session/i);
      return true;
    });
    await opener.evaluate('window.closingPopup = window.open("about:blank", "closing-popup"); void 0');
    await checked;
    offWindow();
  } finally {
    windowDone(); offGate(); await cleanup();
  }
});

async function boundsOf(page, selector) {
  return page.evaluate(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`);
}

test("locator filters and chained getters preserve parent scope", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async (t) => {
  const { connection, cleanup } = await launch();
  try {
    const page = (await createAgentTabs(connection).create("about:blank")).page;
    await page.goto(`data:text/html,${encodeURIComponent(`<!doctype html>
      <button>Choose</button><span>Shared text</span><label>Account<input id="outside"></label>
      <article id="alpha"><h2>Alpha</h2><b>Ready</b></article>
      <article id="beta"><h2>Beta</h2><i>Waiting</i></article>
      <article id="hidden" style="display:none"><h2>Hidden</h2></article>
      <section id="parent"><button id="choose">Choose</button><span id="shared">Shared text</span>
        <label>Account<input id="inside"></label></section>`)}`);
    const cards = page.locator("article");
    const ids = (locator) => locator.evaluateAll(nodes => nodes.map(node => node.id));
    for (const [name, options, expected] of [
      ["hasText", { hasText: "ALPHA" }, ["alpha"]],
      ["hasText regex", { hasText: /^BetaWaiting$/ }, ["beta"]],
      ["has", { has: page.locator("b") }, ["alpha"]],
      ["hasNot", { hasNot: page.locator("b") }, ["beta", "hidden"]],
      ["hasNotText", { hasNotText: "ALPHA" }, ["beta", "hidden"]],
      ["hasNotText regex", { hasNotText: /Beta/ }, ["alpha", "hidden"]],
      ["visible true", { visible: true }, ["alpha", "beta"]],
      ["visible false", { visible: false }, ["hidden"]],
    ]) {
      await t.test(name, async () => {
        const filtered = cards.filter(options);
        assert.deepEqual(await ids(filtered), expected);
        assert.equal(await filtered.count(), expected.length);
        assert.equal(await filtered.first().getAttribute("id"), expected[0]);
      });
    }
    await t.test("unknown filter option throws", () => {
      assert.throws(() => cards.filter({ typo: true }), /Unknown.*filter.*typo/i);
    });
    for (const [method, args, expected] of [
      ["getByRole", ["button", { name: "Choose", exact: true }], "choose"],
      ["getByText", ["Shared text", { exact: true }], "shared"],
      ["getByLabel", ["Account", { exact: true }], "inside"],
    ]) {
      await t.test(method, async () => {
        const child = page.locator("#parent")[method](...args);
        assert.equal(await child.count(), 1);
        assert.equal(await child.getAttribute("id"), expected);
      });
    }
    await t.test("composed filters and relative inner locators", async () => {
      const inner = page.locator("h2").filter({ hasText: "Alpha" });
      const filtered = cards.filter({ has: inner, hasNotText: /Waiting/, visible: true });
      assert.deepEqual(await ids(filtered), ["alpha"]);
      assert.deepEqual(await ids(cards.filter({ has: page.locator("h2").first() })), ["alpha", "beta", "hidden"]);
      assert.deepEqual(await ids(cards.filter({ has: page.locator("body").locator("b") })), []);
      assert.equal(await filtered.getByText("Ready").textContent(), "Ready");
      assert.equal(await cards.filter({ visible: true }).last().getAttribute("id"), "beta");
      assert.deepEqual(await ids(cards.filter({ hasText: "a" }).filter({ hasNotText: "Alpha" })), ["beta"]);
    });
  } finally {
    await cleanup();
  }
});

// Public Playwright API (#146): members generated scripts call that used to throw "is not a function".
test("page.waitForTimeout, page.setContent, allTextContents/allInnerTexts and locator.and/or follow Playwright", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async (t) => {
  // /hang.png stays pending until released: setContent replaces the DOM but keeps the Document, so an unfinished image
  // would also hold back the load event of every later setContent on this page.
  const pendingImages = [];
  let released = false;
  const site = createServer((req, res) => {
    if (req.url === "/hang.png" && !released) return pendingImages.push(res);
    res.writeHead(200, { "content-type": "text/css" }).end("p { color: rgb(1, 2, 3) }");
  });
  await new Promise(resolve => site.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${site.address().port}`;
  const { connection, cleanup } = await launch();
  try {
    const page = (await createAgentTabs(connection).create("about:blank")).page;

    await t.test("waitForTimeout waits at least the given time", async () => {
      const start = performance.now();
      await page.waitForTimeout(100);
      assert.ok(performance.now() - start >= 99, "resolved before the timeout elapsed");
    });

    await t.test("setContent replaces the document and waits for load by default", async () => {
      await page.setContent(`<link rel="stylesheet" href="${origin}/style.css"><p id="set">written</p><script>window.__ran = true</script>`);
      assert.deepEqual(await page.evaluate(`[document.readyState, document.querySelector("#set").textContent, window.__ran, getComputedStyle(document.querySelector("#set")).color]`), ["complete", "written", true, "rgb(1, 2, 3)"]);
    });

    await t.test("setContent honors waitUntil and timeout", async () => {
      const hanging = `<p id="hang">waiting</p><img src="${origin}/hang.png">`;
      await assert.rejects(page.setContent(hanging, { timeout: 300 }), /Timeout 300ms exceeded/);
      await page.setContent(hanging, { waitUntil: "domcontentloaded", timeout: 300 });
      assert.equal(await page.locator("#hang").textContent(), "waiting");
      await assert.rejects(page.setContent("<p>x</p>", { waitUntil: "never" }), /waitUntil/);
      released = true;
      for (const res of pendingImages.splice(0)) res.end();
      await page.setContent(`<p id="idle">idle</p><img src="${origin}/hang.png">`, { waitUntil: "networkidle", timeout: 10000 });
      assert.equal(await page.evaluate(`document.images[0].complete`), true);
      await page.setContent(`<p id="commit">committed</p>`, { waitUntil: "commit" });
      assert.equal(await page.locator("#commit").textContent(), "committed");
      await page.setContent(`<p id="unbounded">no timeout</p>`, { timeout: 0 });
      assert.equal(await page.locator("#unbounded").textContent(), "no timeout");
    });

    await page.setContent(`<ul>
      <li id="one"><button id="a" class="primary">One</button></li>
      <li id="two"><button id="b" style="text-transform: uppercase">two</button></li>
      <li id="three" style="display: none"><span id="c" class="primary">Three</span></li>
    </ul>`);
    const ids = (locator) => locator.evaluateAll(nodes => nodes.map(node => node.id));

    await t.test("allTextContents and allInnerTexts read every match", async () => {
      assert.deepEqual(await page.locator("li").allTextContents(), ["One", "two", "Three"]);
      assert.deepEqual(await page.locator("li").allInnerTexts(), ["One", "TWO", "Three"]);
      assert.deepEqual(await page.getByRole("button").allTextContents(), ["One", "two"]);
      assert.deepEqual(await page.locator("li").filter({ visible: true }).getByRole("button").allInnerTexts(), ["One", "TWO"]);
      assert.deepEqual(await page.locator("table").allTextContents(), []);
    });

    await t.test("and keeps elements matching both locators", async () => {
      const primary = page.getByRole("button").and(page.locator(".primary"));
      assert.deepEqual(await ids(primary), ["a"]);
      assert.equal(await primary.textContent(), "One");
      assert.equal(await page.locator("#a").and(page.locator("#b")).count(), 0);
      assert.deepEqual(await ids(page.locator("li").filter({ visible: true }).locator("button").and(page.locator(".primary"))), ["a"]);
    });

    await t.test("or matches either locator once, in document order", async () => {
      assert.deepEqual(await ids(page.locator("#c").or(page.locator("#a"))), ["a", "c"]);
      assert.deepEqual(await ids(page.locator("button").or(page.locator(".primary"))), ["a", "b", "c"]);
      assert.equal(await page.locator("#missing").or(page.getByRole("button", { name: "two" })).getAttribute("id"), "b");
      assert.deepEqual(await page.locator("#c").or(page.locator("#a")).allTextContents(), ["One", "Three"]);
    });

    await t.test("and/or reject a non-locator argument", () => {
      assert.throws(() => page.locator("li").and("li"), /must be a locator/);
      assert.throws(() => page.locator("li").or({}), /must be a locator/);
    });
  } finally {
    await cleanup();
    site.closeAllConnections();
    site.close();
  }
});

async function waitForState(page, expression, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await page.evaluate(expression)) return;
    if (Date.now() > deadline) throw new Error(`waitForState timed out: ${expression}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test("cua drives coordinate click, type, keypress, and scroll", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const { connection, cleanup } = await launch();
  try {
    const page = (await createAgentTabs(connection).create("about:blank")).page;
    await page.goto(FIXTURE);
    const cua = createCua(page);

    const btn = await boundsOf(page, "#btn");
    await cua.click({ x: btn.x + btn.width / 2, y: btn.y + btn.height / 2 });
    assert.ok((await page.evaluate("window.__log")).includes("btn-clicked"), "coordinate click hits the button");

    await page.locator("#name").click();
    await cua.type({ text: "hello cua" });
    assert.equal(await page.evaluate("document.getElementById('name').value"), "hello cua");

    await cua.keypress({ keys: ["ControlOrMeta", "a"] });
    const selected = await page.evaluate("window.getSelection().toString()");
    assert.equal(selected, "hello cua", "ControlOrMeta+a selects the input text");

    await cua.scroll({ x: 200, y: 200, scrollX: 0, scrollY: 400 });
    await waitForState(page, "window.scrollY > 100");

    const shot = await cua.getVisibleScreenshot();
    assert.ok(shot.length > 1000, "base64 screenshot returned");
    assert.doesNotThrow(() => Buffer.from(shot, "base64"));
  } finally {
    await cleanup();
  }
});

// Public page API: locator.screenshot() crops to the element plus its margin (#56: it threw "Invalid parameters" because
// the margin argument received the element).
test("locator.screenshot crops to the element and its margin", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const { connection, cleanup } = await launch();
  try {
    const page = (await createAgentTabs(connection).create("about:blank")).page;
    await page.goto(FIXTURE);
    const size = (png) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
    const tight = size(await page.locator("#btn").screenshot({ type: "png", margin: 0 }));
    const scale = tight.width / 120;
    assert.ok(scale > 0, "the element screenshot has a width");
    assert.ok(Math.abs(tight.height / scale - 40) <= 1, `the crop is the 120x40 button (${tight.width}x${tight.height})`);
    const padded = size(await page.locator("#btn").screenshot({ type: "png", margin: 10 }));
    assert.ok(Math.abs(padded.width / scale - 140) <= 1 && Math.abs(padded.height / scale - 60) <= 1, `a 10px margin pads every side (${padded.width}x${padded.height})`);
  } finally {
    await cleanup();
  }
});

test("captcha clicks checkbox, drags slider, and OCRs text region", { skip: !SHELL && "no chromium binary found", timeout: 90000 }, async () => {
  const { connection, cleanup } = await launch();
  try {
    const page = (await createAgentTabs(connection).create("about:blank")).page;
    await page.goto(FIXTURE);
    // macOS runs the real Vision OCR; elsewhere a recording OCR proves readText hands over the cropped PNG.
    const ocrCalls = [];
    const ocr = process.platform === "darwin" ? undefined : async (png) => { ocrCalls.push(png); return ""; };
    const captcha = createCaptcha(page, { ocr });

    const box = await boundsOf(page, "#captcha-box");
    const tree = await captcha.click({ x: box.x, y: box.y, width: 30, height: box.height }, { settleMs: 100 });
    assert.ok((await page.evaluate("window.__log")).includes("cb-true"), "checkbox captcha becomes checked");
    assert.equal(typeof tree, "string");
    assert.ok(tree.includes("I'm not a robot"), "post-click snapshot tree returned");

    const handle = await boundsOf(page, "#handle");
    const track = await boundsOf(page, "#slider");
    const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
    const to = { x: track.x + track.width - 20, y: from.y };
    await captcha.drag(from, to, { steps: 10, settleMs: 100 });
    const log = await page.evaluate("window.__log");
    assert.ok(log.includes("drag-start") && log.includes("drag-end"), "drag lifecycle events fired");
    const lastX = Math.max(...log.filter(e => e.startsWith("drag-x-")).map(e => Number(e.slice(7))));
    assert.ok(lastX > 150, `slider handle moved right (x=${lastX})`);

    const textBounds = await boundsOf(page, "#captcha-text");
    const ocrText = await captcha.readText(textBounds);
    if (ocr) {
      assert.equal(ocrCalls.length, 1, "readText calls the OCR once");
      const png = ocrCalls[0];
      assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "OCR receives a PNG");
      const scale = png.readUInt32BE(16) / textBounds.width;
      assert.ok(Math.abs(png.readUInt32BE(20) / textBounds.height - scale) < 0.05, "PNG is cropped to the text bounds");
      const full = await page.screenshot({ type: "png" });
      assert.ok(png.readUInt32BE(16) < full.readUInt32BE(16), "PNG is a crop, not the full viewport");
    } else {
      assert.ok(ocrText, "OCR returned text");
      assert.equal(ocrText.replace(/[^A-Z0-9]/gi, "").toUpperCase(), "XK7M2");
    }
  } finally {
    await cleanup();
  }
});

// Public popup API: both opening paths deliver an attached, usable, owned page.
// Served over http: Chromium refuses a page-initiated top-level navigation to a data: URL.
test("clicking a target=_blank link opens the linked page in a new tab", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const site = createServer((req, res) => {
    const body = req.url === "/linked"
      ? "<title>Linked page</title><p>the linked page body text</p>"
      : '<p>a page with one link and enough text</p><a id="blank" href="/linked" target="_blank">Open in a new tab</a>';
    res.writeHead(200, { "content-type": "text/html" }).end(body);
  });
  await new Promise(resolve => site.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${site.address().port}`;
  const { connection, cleanup } = await launch();
  try {
    const page = (await createAgentTabs(connection).create("about:blank")).page;
    await page.goto(`${origin}/`);
    const tabs = createAgentTabs(connection);
    for (const trigger of ["window.open", "target=_blank"]) {
      let resolveListener;
      const listened = new Promise(resolve => { resolveListener = resolve; });
      const off = page.on("popup", resolveListener);
      const opened = page.waitForEvent("popup", { timeout: 10000 });
      if (trigger === "window.open") await page.evaluate(`window.open(${JSON.stringify(`${origin}/linked`)}, "qa-popup"); void 0`);
      else await page.locator("#blank").click();
      const popup = await opened;
      off();
      assert.equal(typeof popup.url, "function", `${trigger} delivers a page, not metadata`);
      assert.equal(await listened, popup, "on and waitForEvent receive the same page");
      assert.equal(popup.url(), `${origin}/linked`);
      assert.deepEqual(popup.popupMetadata, { url: `${origin}/linked`, windowName: trigger === "window.open" ? "qa-popup" : "_blank" });
      assert.match((await popup.snapshot()).tree, /the linked page body text/);
      await popup.goto(`${origin}/`);
      assert.equal(popup.url(), `${origin}/`);
      assert.match((await popup.snapshot()).tree, /Open in a new tab/);
      assert.equal(tabs.get(popup.targetId).page, popup, "popup belongs to the connection's manager");
    }
    await tabs.closeAll();
    const remaining = await connection.listTargets();
    assert.ok(!remaining.some(target => target.url.startsWith(origin)), "closing owned tabs closes the popups too");
  } finally {
    await cleanup();
    site.close();
  }
});
