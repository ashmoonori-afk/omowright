import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, globSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { connectPipe } from "../src/index.js";
import { urlMatches } from "../src/url-match.js";
import { removeTreeSync } from "./fixtures/remove-tree.mjs";

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
const LIVE = { skip: !SHELL && "no chromium binary found", timeout: 60000 };

// Public API contract (#145): a waitForURL string is a Playwright glob. Expected values are taken from
// Playwright's own urlMatches and glob test suite, so a divergence from its rules fails here.
test("URL strings match with Playwright's glob rules", async () => {
  const cases = [
    ["**/*.js", "https://localhost:8080/foo.js", true],
    ["**/*.css", "https://localhost:8080/foo.js", false],
    ["*.js", "https://localhost:8080/foo.js", false],
    ["https://**/*.js", "https://localhost:8080/foo.js", true],
    ["https://foo/**/bar.js", "https://foo/bar.js", true],
    ["https://foo/**/**/bar.js", "https://foo/bar.js", true],
    ["**/foo/**", "http://playwright.dev/foo/bar", true],
    ["http://localhost:3000/signin-oidc*", "http://localhost:3000/signin-oidc/foo", false],
    ["http://localhost:3000/signin-oidc*", "http://localhost:3000/signin-oidcnice", true],
    ["**/{a,b}.js", "https://localhost:8080/b.js", true],
    ["**/{a,b}.js", "https://localhost:8080/c.js", false],
    ["**/*.{png,jpg,jpeg}", "https://localhost:8080/c.jpeg", true],
    ["my.{p,y}://**", "my.p://foo", false],
    ["my.{p,y}://**", "my.p://foo/", true],
    ["**/api/v[0-9]", "http://example.com/api/v[0-9]", true],
    ["**/api/v[0-9]", "http://example.com/api/version", false],
    ["http://playwright.dev/f??", "http://playwright.dev/foo", false],
    ["http://playwright.dev/f??", "http://playwright.dev/f??", true],
    ["**/api\\?param", "http://example.com/api?param", true],
    ["**/api\\?param", "http://example.com/api-param", false],
    ["http://playwright.dev\\?x=y", "http://playwright.dev/?x=y", true],
    ["**/three-columns/settings.html\\?**id=settings-**", "http://mydomain:8080/blah/blah/three-columns/settings.html?id=settings-e3c58efe&blah", true],
    ["http://playwright.dev", "http://playwright.dev/", true],
    ["http://playwright.dev?a=b", "http://playwright.dev/?a=b", true],
    ["h*://playwright.dev", "http://playwright.dev/", true],
    ["http://*.playwright.dev?x=y", "http://api.playwright.dev/?x=y", true],
    ["HtTpS://pLaYwRiGhT.dEv/fooBAR", "https://playwright.dev/fooBAR", true],
    ["https://playwright.dev/fooBAR", "https://playwright.dev/foobar", false],
    ["http://example.com:80/path", "http://example.com/path", true],
    ["http://example.com/foo bar", "http://example.com/foo%20bar", true],
    ["http://playwright.dev/foo$$bar", "http://playwright.dev/foo$$bar", true],
    ["**?a=b", "https://localhost:3000/?a=b", true],
    ["about:*", "about:blank", true],
    ["about:*", "notabout:blank", false],
    ["", "https://playwright.dev/anything", true],
  ];
  for (const [glob, url, expected] of cases) assert.equal(await urlMatches(url, glob), expected, `${glob} vs ${url}`);

  const global = /done/g;
  assert.equal(await urlMatches("https://playwright.dev/done", global), true);
  assert.equal(await urlMatches("https://playwright.dev/done", global), true, "a global RegExp restarts at index 0");
  await assert.rejects(urlMatches("https://playwright.dev/", "{foo"), /Invalid glob pattern "\{foo": unmatched '\{'/);
  await assert.rejects(urlMatches("https://playwright.dev/", "{{foo}"), /nested '\{' is not supported/);
  await assert.rejects(urlMatches("https://playwright.dev/", 42), TypeError);
});

const html = (body) => `<!doctype html><title>wait</title><main><p>${body}</p></main>`;

// /gated holds its parser-blocking script and its image until the test releases them, so the test decides
// when DOMContentLoaded and load can fire. /busy keeps one request in flight at all times without timers:
// two fetch chains take turns, and the server answers a held request only when the next one arrives.
async function serveWaitFixture() {
  const gates = { script: Promise.withResolvers(), image: Promise.withResolvers() };
  const relay = [];
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    const { pathname } = new URL(request.url, "http://fixture.invalid");
    const send = (type, body) => { response.writeHead(200, { "content-type": type, "cache-control": "no-store" }); response.end(body); };
    if (pathname === "/gated") return send("text/html", `${html("gated")}<script src="/gate/script.js"></script><img src="/gate/image.svg">`);
    if (pathname === "/gate/script.js") { await gates.script.promise; return send("text/javascript", "window.scriptRan = true;"); }
    if (pathname === "/gate/image.svg") { await gates.image.promise; return send("image/svg+xml", "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\"/>"); }
    if (pathname === "/busy") {
      return send("text/html", `${html("busy")}<script>for (const chain of ["a", "b"]) (async () => { for (let n = 0; ; n++) await fetch("/relay?" + chain + n, { cache: "no-store" }).then(r => r.text()); })();</script>`);
    }
    if (pathname === "/relay") {
      relay.push(() => send("text/plain", "ok"));
      if (relay.length >= 2) relay.shift()();
      return;
    }
    send("text/html", html(pathname));
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    release: (name) => gates[name].resolve(),
    async close() {
      gates.script.resolve();
      gates.image.resolve();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function withPage(url, body) {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-wait-"));
  const fixture = await serveWaitFixture();
  const browser = await connectPipe({ browserPath: SHELL, browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`], storageRoot: ud });
  try {
    const page = await browser.newTab(`${fixture.base}${url}`);
    await body(page, fixture);
  } finally {
    await browser.close();
    await fixture.close();
    removeTreeSync(ud);
  }
}

// Public API contract (#145): waitForURL takes Playwright's URL match forms, so a glob, a RegExp and a
// predicate on the URL object each wait for the navigation that produces the matching URL.
test("waitForURL waits for a URL matching a Playwright glob, RegExp or URL predicate", LIVE, async () => {
  await withPage("/start", async (page, { base }) => {
    const matches = [
      ["glob", "**/done?x=1"],
      ["brace glob", `${base}/{done,finished}?x=*`],
      ["RegExp", /\/done\?x=1$/],
      ["predicate", (url) => url instanceof URL && url.pathname === "/done" && url.searchParams.get("x") === "1"],
    ];
    for (const [label, match] of matches) {
      await page.goto(`${base}/start`);
      const waiting = page.waitForURL(match, { timeout: 5000 });
      await page.goto(`${base}/done?x=1`, { waitUntil: "commit" });
      await assert.doesNotReject(waiting, label);
      assert.equal(page.url(), `${base}/done?x=1`, label);
    }
    await assert.rejects(page.waitForURL("**/done?x=2", { timeout: 300 }), /Timed out waiting for URL match/);
  });
});

// Public API contract (#145): domcontentloaded and load mean the document events, not a readiness heuristic,
// and the timeout option bounds the wait.
test("waitForLoadState waits for DOMContentLoaded and the load event", LIVE, async () => {
  await withPage("/start", async (page, fixture) => {
    const committed = page.waitForEvent("framenavigated", { timeout: 10000, predicate: (frame) => frame.url === `${fixture.base}/gated` });
    await page.goto(`${fixture.base}/gated`, { waitUntil: "commit" });
    await committed;
    await assert.rejects(page.waitForLoadState("domcontentloaded", { timeout: 500 }), /Timed out waiting for load state "domcontentloaded"/);
    fixture.release("script");
    await page.waitForLoadState("domcontentloaded", { timeout: 10000 });
    assert.equal(await page.evaluate("window.scriptRan === true && document.readyState !== 'loading'"), true);
    await assert.rejects(page.waitForLoadState("load", { timeout: 500 }), /Timed out waiting for load state "load"/);
    fixture.release("image");
    await page.waitForLoadState("load", { timeout: 10000 });
    assert.equal(await page.evaluate("document.readyState"), "complete");
  });
});

// Public API contract (#145): networkidle resolves only after 500 ms without network requests, so a page that
// always has a request in flight times out, and a quiet page resolves.
test("waitForLoadState('networkidle') waits for the network to go quiet", LIVE, async () => {
  await withPage("/busy", async (page, { base }) => {
    await assert.rejects(page.waitForLoadState("networkidle", { timeout: 1500 }), /Timed out waiting for load state "networkidle"/);
    await page.goto(`${base}/quiet`);
    await page.waitForLoadState("networkidle", { timeout: 10000 });
  });
});
