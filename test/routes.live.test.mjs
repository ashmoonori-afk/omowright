import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, globSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { connectPipe, createAgentTabs } from "../src/index.js";
import { createRoutes } from "../src/routes.js";
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

const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html><head><title>routes fixture</title></head>
<body>
<script>window.__imgError=false;window.__imgLoad=false;</script>
<img src="/pixel.png" id="pic"
  onerror="window.__imgError=true"
  onload="window.__imgLoad=true">
<p>fixture page with enough text content for the readiness probe to pass on load</p>
</body></html>`);
      return;
    }
    if (url === "/pixel.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PIXEL_PNG);
      return;
    }
    if (url === "/echo") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ method: req.method, header: req.headers["x-route"], body }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
    server.on("error", reject);
  });
}

test("live abort of png fires img onerror", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-routes-png-"));
  const { server, url } = await startFixtureServer();
  let connection;
  try {
    connection = await connectPipe({
      browserPath: SHELL,
      browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
      storageRoot: ud,
    });
    const page = (await createAgentTabs(connection).create("about:blank")).page;
    const routes = createRoutes(page);
    await routes.route("*.png", route => route.abort());
    await page.goto(url);
    const imgState = await page.evaluate(`new Promise((resolve, reject) => {
      const finish = () => resolve({ error: window.__imgError === true, load: window.__imgLoad === true });
      if (window.__imgError || window.__imgLoad) return finish();
      const img = document.getElementById("pic");
      if (!img) return reject(new Error("img#pic missing"));
      img.addEventListener("error", finish);
      img.addEventListener("load", finish);
      setTimeout(() => reject(new Error("timed out waiting for img error or load")), 8000);
    })`);
    assert.equal(imgState.error, true, "aborted image fires onerror");
    assert.equal(imgState.load, false, "aborted image does not load");
    await routes.dispose();
  } finally {
    await connection?.close();
    removeTreeSync(ud);
    await new Promise(resolve => server.close(resolve));
  }
});

test("live fulfill mocks /api/x json even when the server returns 404", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-routes-api-"));
  const { server, url } = await startFixtureServer();
  let connection;
  try {
    connection = await connectPipe({
      browserPath: SHELL,
      browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
      storageRoot: ud,
    });
    const page = (await createAgentTabs(connection).create("about:blank")).page;
    const routes = createRoutes(page);
    await routes.route("*/api/x", route => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ mocked: true }),
    }));
    await page.goto(url);
    const payload = await page.evaluate("fetch('/api/x').then(r => r.json())");
    assert.deepEqual(payload, { mocked: true });
    await routes.dispose();
  } finally {
    await connection?.close();
    removeTreeSync(ud);
    await new Promise(resolve => server.close(resolve));
  }
});

// Public routing contract: a missing adapter, a second interceptor, or incorrect
// dispatch/lifetime semantics changes actual responses from this local server.
// Existing tests cover only the legacy helper; this needs no production seam.
test("page routes mock, override, fall back and unregister through one interceptor", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-page-routes-"));
  const { server, url } = await startFixtureServer();
  let connection;
  try {
    connection = await connectPipe({
      browserPath: SHELL,
      browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
      storageRoot: ud,
    });
    const page = (await createAgentTabs(connection).create("about:blank")).page;
    await page.goto(url);
    const fetchText = pathname => page.evaluate(`fetch(${JSON.stringify(pathname)}).then(r => r.text())`);
    const legacy = createRoutes(page);
    await legacy.route("*/legacy", route => route.fulfill({ body: "legacy" }));
    await page.route("**/api/{x,y}", (route, request) => {
      assert.equal(route.request(), request);
      assert.equal(request.method(), "GET");
      assert.equal(request.resourceType(), "xhr");
      assert.equal(request.headers().accept, "*/*");
      assert.equal(request.postData(), null);
      assert.equal(request.url(), `${url}/api/x`);
      return route.fulfill({ status: 201, json: { mocked: true } });
    }, { times: 1 });
    assert.deepEqual(await page.evaluate("fetch('/api/x').then(async r => ({ status: r.status, type: r.headers.get('content-type'), body: await r.json() }))"),
      { status: 201, type: "application/json", body: { mocked: true } });
    assert.equal(await fetchText("/api/x"), "not found");
    assert.equal(await fetchText("/legacy"), "legacy");

    await page.route(parsed => parsed.pathname === "/override", route => route.continue({
      url: `${url}/echo`, method: "POST", headers: { "x-route": "yes" }, postData: "changed",
    }));
    assert.deepEqual(JSON.parse(await fetchText("/override")), { method: "POST", header: "yes", body: "changed" });
    await page.route(/\/blocked$/, route => route.abort("blockedbyclient"));
    assert.equal(await page.evaluate("fetch('/blocked').then(() => 'loaded', () => 'blocked')"), "blocked");

    const first = route => route.fulfill({ body: "first" });
    const second = route => route.fulfill({ body: "second" });
    await page.route("**/chain", first);
    await page.route("**/chain", second);
    await page.route("**/chain", route => route.fallback(), { times: 1 });
    assert.equal(await fetchText("/chain"), "second");
    await page.unroute("**/chain", second);
    assert.equal(await fetchText("/chain"), "first");
    await page.unroute("**/chain");
    assert.equal(await fetchText("/chain"), "not found");

    const bodyPath = path.join(ud, "body.txt");
    writeFileSync(bodyPath, "file body");
    await page.route("**/file", route => route.fulfill({ path: bodyPath, contentType: "text/plain" }));
    assert.equal(await fetchText("/file"), "file body");
    await page.unrouteAll();
    assert.equal(legacy.enabled, false);
    assert.equal(await fetchText("/legacy"), "not found");
    await page.route("**/once", route => route.fulfill({ body: "once" }), { times: 1 });
    assert.equal(await fetchText("/once"), "once");
    assert.equal(await fetchText("/once"), "not found");
    assert.equal(legacy.enabled, false);
  } finally {
    await connection?.close();
    removeTreeSync(ud);
    await new Promise(resolve => server.close(resolve));
  }
});
