import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { connectPipe, createAgentTabs } from "../src/index.js";
import { removeTreeSync } from "./fixtures/remove-tree.mjs";

const SHELL = process.env.SHELL_BIN;
const options = { skip: !SHELL && "set SHELL_BIN to a Chromium headless shell", timeout: 60_000 };

// Public setup contracts at the browser boundary: missing adapters, wrong CDP
// worlds, or late OOPIF installation change these document-produced results.
// No existing test owns these members; no production-only test seam is needed.
async function fixture(run) {
  const directory = mkdtempSync(path.join(tmpdir(), "omowright-page-setup-"));
  const server = http.createServer((req, res) => {
    if (req.url === "/headers") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(req.headers));
    }
    res.writeHead(200, { "content-type": "text/html" });
    const report = `({
      seed: window.seed, content: window.fromContent, file: window.fromFile,
      header: ${JSON.stringify(req.headers["x-setup"] ?? null)},
      sum: typeof window.sum === "function" ? await window.sum(4, 5) : null,
      binding: typeof window.who === "function" ? await window.who("fixture", location.pathname) : null
    })`;
    if (req.url.startsWith("/child")) {
      return res.end(`<!doctype html><script>
        addEventListener("message", async event => {
          if (event.data === "late-source") event.source.postMessage({ lateSource: await window.lateSource() }, event.origin);
        });
        (async () => parent.postMessage({ setupReport: await ${report} }, "*"))();
      </script><p>child fixture</p>`);
    }
    res.end(`<!doctype html><script>
      window.earlySeed = window.seed;
      window.reports = [];
      window.childrenReady = new Promise(resolve => addEventListener("message", event => {
        if (!event.data.setupReport) return;
        reports.push(event.data.setupReport);
        if (reports.length === 2) resolve(reports);
      }));
      window.mainReport = (async () => ${report})();
    </script><p>page setup fixture</p>
    <iframe src="/child"></iframe>
    <iframe src="http://localhost:${server.address().port}/child"></iframe>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let connection, page;
  try {
    connection = await connectPipe({
      browserPath: SHELL,
      browserArgs: ["--headless", "--no-sandbox", "--site-per-process", "--no-first-run", `--user-data-dir=${directory}`],
      storageRoot: directory,
    });
    const tabs = createAgentTabs(connection);
    ({ page } = await tabs.create());
    await run({ page, tabs, url: `http://127.0.0.1:${server.address().port}` });
  } finally {
    await page?.close();
    await connection?.close();
    await new Promise(resolve => server.close(resolve));
    removeTreeSync(directory);
  }
}

test("addInitScript runs function, content, path and strings before scripts in every new document", options, () => fixture(async ({ page, url }) => {
  await page.addInitScript(value => { window.seed = value; }, 37);
  await page.addInitScript({ content: "window.fromContent = 12" });
  await page.addInitScript({ path: "test/fixtures/setup-init.js" });
  await page.addInitScript("window.fromString = 8");
  await Promise.all([
    page.addInitScript("window.initCount = (window.initCount || 0) + 1"),
    page.addInitScript("window.initCount = (window.initCount || 0) + 1"),
  ]);
  for (const suffix of ["/", "/again"]) {
    await page.goto(url + suffix, { waitUntil: "load" });
    assert.equal(await page.evaluate("window.earlySeed"), 37);
    assert.equal(await page.evaluate("window.fromString"), 8);
    assert.equal(await page.evaluate("window.initCount"), 2);
    const reports = await page.evaluate("Promise.all([mainReport, childrenReady]).then(([main, children]) => [main, ...children])");
    assert.equal(reports.length, 3);
    for (const report of reports) {
      assert.equal(report.seed, 37);
      assert.equal(report.content, 12);
      assert.equal(report.file, 19);
    }
  }
}));

test("exposeFunction awaits callbacks, rejects errors and survives frame creation and navigation", options, () => fixture(async ({ page, url }) => {
  await page.exposeFunction("sum", async (a, b) => a + b);
  assert.equal(await page.evaluate("sum(2, 3)"), 5);
  await assert.rejects(page.exposeFunction("sum", () => 0), /already/i);
  await page.exposeFunction("fail", () => { throw new TypeError("binding failed"); });
  assert.deepEqual(await page.evaluate("fail().catch(e => ({ name: e.name, message: e.message }))"),
    { name: "TypeError", message: "binding failed" });
  await page.exposeFunction("nothing", () => undefined);
  assert.equal(await page.evaluate("nothing().then(value => value === undefined)"), true);
  await page.exposeFunction("echo", value => value);
  assert.deepEqual(await page.evaluate("echo({ a: undefined, b: NaN, c: -0 }).then(v => [v.a === undefined, Number.isNaN(v.b), Object.is(v.c, -0)])"), [true, true, true]);
  // A transient console subscriber must not disable Runtime while bindings use it.
  const off = page.on("console", () => {});
  off();
  for (const suffix of ["/", "/again"]) {
    await page.goto(url + suffix, { waitUntil: "load" });
    const reports = await page.evaluate("Promise.all([mainReport, childrenReady]).then(([main, children]) => [main, ...children])");
    assert.deepEqual(reports.map(report => report.sum), [9, 9, 9]);
    assert.deepEqual(await page.evaluate("Promise.all([sum(1, 2), sum(10, 20)])"), [3, 30]);
  }
  await page.exposeFunction("late", () => "installed");
  assert.equal(await page.evaluate("document.querySelector('iframe').contentWindow.late()"), "installed");
}));

test("setExtraHTTPHeaders replaces headers for navigation, frames and later fetches", options, () => fixture(async ({ page, url }) => {
  await page.setExtraHTTPHeaders({ "X-Setup": "first" });
  await page.goto(url, { waitUntil: "load" });
  const reports = await page.evaluate("Promise.all([mainReport, childrenReady]).then(([main, children]) => [main, ...children])");
  assert.deepEqual(reports.map(report => report.header), ["first", "first", "first"]);
  await page.setExtraHTTPHeaders({ "X-Setup": "second" });
  assert.equal(await page.evaluate("fetch('/headers').then(r => r.json()).then(h => h['x-setup'])"), "second");
  await page.setExtraHTTPHeaders({});
  assert.equal(await page.evaluate("fetch('/headers').then(r => r.json()).then(h => h['x-setup'] === undefined)"), true);
  await assert.rejects(page.setExtraHTTPHeaders({ "X-Setup": 1 }), /string/i);
}));

test("exposeBinding supplies the real context, page and calling frame across documents", options, () => fixture(async ({ page, url }) => {
  const off = page.on("console", () => {});
  await page.exposeBinding("who", async (source, ...args) => {
    assert.equal(source.context, page.context());
    assert.equal(source.page, page);
    assert.ok(page.frameManager.getFrame(source.frame.frameId));
    return { url: source.frame.url(), main: source.frame.parentFrame() === null, args };
  });
  assert.deepEqual(await page.evaluate("who('current', 7)"), { url: "about:blank", main: true, args: ["current", 7] });
  await assert.rejects(page.exposeFunction("who", () => 0), /already/i);
  await assert.rejects(page.exposeBinding("who", () => 0), /already/i);
  off();
  for (const suffix of ["/", "/again"]) {
    await page.goto(url + suffix, { waitUntil: "load" });
    const reports = await page.evaluate("Promise.all([mainReport, childrenReady]).then(([main, children]) => [main, ...children])");
    assert.deepEqual(reports[0].binding, { url: url + suffix, main: true, args: ["fixture", suffix] });
    assert.equal(reports.length, 3);
    for (const report of reports.slice(1)) {
      assert.equal(new URL(report.binding.url).pathname, "/child");
      assert.equal(report.binding.main, false);
      assert.deepEqual(report.binding.args, ["fixture", "/child"]);
    }
  }
  await page.exposeBinding("lateSource", source => source.frame.url());
  assert.equal(await page.evaluate("document.querySelector('iframe').contentWindow.lateSource()"), url + "/child");
  const crossOrigin = await page.evaluate(`new Promise(resolve => {
    const frame = document.querySelectorAll("iframe")[1];
    const listener = event => {
      if (event.source !== frame.contentWindow || !event.data.lateSource) return;
      removeEventListener("message", listener);
      resolve(event.data.lateSource);
    };
    addEventListener("message", listener);
    frame.contentWindow.postMessage("late-source", "*");
  })`);
  assert.equal(new URL(crossOrigin).hostname, "localhost");
  assert.equal(new URL(crossOrigin).pathname, "/child");
}));

test("setViewportSize changes viewport and screen and updates the agent navigation pin", options, () => fixture(async ({ page, tabs, url }) => {
  await page.setViewportSize({ width: 801, height: 603 });
  await page.goto(url, { waitUntil: "load" });
  assert.deepEqual(page.viewportSize(), { width: 801, height: 603 });
  assert.deepEqual(tabs.get(page.targetId).viewport, { width: 801, height: 603 });
  assert.deepEqual(await page.evaluate("({ width: innerWidth, height: innerHeight, screenWidth: screen.width, screenHeight: screen.height })"),
    { width: 801, height: 603, screenWidth: 801, screenHeight: 603 });
  await assert.rejects(page.setViewportSize({ width: -1, height: 2 }), /positive integers/);
}));

test("emulateMedia changes CSS features, preserves omitted features and clears null overrides", options, () => fixture(async ({ page, url }) => {
  await page.goto(url, { waitUntil: "load" });
  const query = "(() => ['print', '(prefers-color-scheme: dark)', '(prefers-reduced-motion: reduce)', '(forced-colors: active)', '(prefers-contrast: more)'].map(q => matchMedia(q).matches))";
  const baseline = await page.evaluate(query + "()");
  await page.emulateMedia({ media: "print", colorScheme: "dark", reducedMotion: "reduce", forcedColors: "active", contrast: "more" });
  assert.deepEqual(await page.evaluate(query + "()"), [true, true, true, true, true]);
  await page.emulateMedia({ colorScheme: "light" });
  assert.deepEqual(await page.evaluate(query + "()"), [true, false, true, true, true]);
  await page.emulateMedia({ media: null, colorScheme: null, reducedMotion: null, forcedColors: null, contrast: null });
  assert.deepEqual(await page.evaluate(query + "()"), baseline);
  await assert.rejects(page.emulateMedia({ media: "invalid" }), /media/);
}));
