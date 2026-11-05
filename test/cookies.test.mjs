import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, globSync, readFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectPipe, createAgentTabs, injectCookies, sanitizeCookies } from "../src/index.js";
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

// Public context contract: real navigations expose bad scoping, cookie rewriting
// and missing origin storage. Raw injection tests below cannot cover these APIs;
// the fixture needs no production seam.
async function withContextFixture(run) {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-context-"));
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === "/set") res.setHeader("set-cookie", "server=received; Path=/; HttpOnly; SameSite=Lax");
    res.end("<p>Local context fixture with enough visible text for navigation readiness.</p>");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let connection;
  try {
    connection = await connectPipe({
      browserPath: SHELL,
      browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
      storageRoot: ud,
    });
    const page = await connection.newTab();
    await run({ connection, page, ud, url: `http://127.0.0.1:${server.address().port}` });
  } finally {
    await connection?.close();
    await new Promise(resolve => server.close(resolve));
    removeTreeSync(ud);
  }
}

test("context cookies survive navigation, filter URLs and clear selected cookies", { skip: !SHELL, timeout: 60000 }, async () => {
  await withContextFixture(async ({ page, url }) => {
    const context = page.context();
    await page.goto(`${url}/set`);
    await context.addCookies([
      { name: "session", value: "root", url: `${url}/`, sameSite: "Strict" },
      { name: "session", value: "scoped", domain: "127.0.0.1", path: "/scope" },
      { name: "other", value: "elsewhere", domain: "example.com", path: "/" },
      { name: "secure", value: "tls", domain: "127.0.0.1", path: "/", secure: true },
      { name: "subdomain", value: "wide", domain: ".example.com", path: "/api" },
      { name: "hostOnly", value: "narrow", domain: "example.com", path: "/" },
    ]);
    await page.goto(`${url}/scope/next`);
    assert.match(await page.evaluate("document.cookie"), /session=scoped/);
    const serverCookie = (await context.cookies()).find(c => c.name === "server");
    assert.deepEqual(serverCookie, {
      name: "server", value: "received", domain: "127.0.0.1", path: "/",
      expires: -1, httpOnly: true, secure: false, sameSite: "Lax",
    });
    const names = cookies => cookies.map(c => `${c.name}:${c.value}`).sort();
    assert.deepEqual(names(await context.cookies(`${url}/scope/next`)), ["server:received", "session:root", "session:scoped"]);
    assert.deepEqual(names(await context.cookies([`${url}/scope-other`])), ["server:received", "session:root"]);
    assert.deepEqual(names(await context.cookies([])), names(await context.cookies()));
    assert.deepEqual(names(await context.cookies("https://sub.example.com/api/x")), ["subdomain:wide"]);
    assert.deepEqual(await context.cookies("https://notexample.com/api/x"), []);
    await assert.rejects(context.addCookies([{ name: "bad", value: "x" }]), /url or domain and path/);
    await assert.rejects(context.addCookies([{ name: "bad", value: "x", url, domain: "127.0.0.1" }]), /either url/);
    await context.clearCookies({ name: "session", path: "/scope" });
    assert.equal((await context.cookies()).filter(c => c.name === "session").length, 1);
    await context.clearCookies({ domain: /example\.com/g, name: /^other$/ });
    assert.equal((await context.cookies()).some(c => c.name === "other"), false);
    await context.clearCookies({ name: "session", domain: "127.0.0.1" });
    assert.equal((await context.cookies()).some(c => c.name === "session"), false);
    await context.clearCookies();
    assert.deepEqual(await context.cookies(), []);
  });
});

test("context storageState saves cookies and visited origins as round-trippable JSON", { skip: !SHELL, timeout: 60000 }, async () => {
  await withContextFixture(async ({ connection, page, url, ud }) => {
    const context = page.context();
    await page.goto(`${url}/set`);
    await page.evaluate("localStorage.setItem('login', 'fixture-token')");
    const otherOrigin = url.replace("127.0.0.1", "localhost");
    await page.goto(otherOrigin);
    await page.evaluate("localStorage.setItem('theme', 'dark')");
    const otherPage = await context.newPage();
    assert.equal(otherPage.context(), context);
    const state = await context.storageState({ path: path.join(ud, "nested", "state.json") });
    assert.equal(await page.url(), `${otherOrigin}/`, "snapshot must not navigate the caller's page");
    assert.deepEqual(JSON.parse(readFileSync(path.join(ud, "nested", "state.json"), "utf8")), state);
    assert.deepEqual(state.origins.sort((a, b) => a.origin.localeCompare(b.origin)), [
      { origin: url, localStorage: [{ name: "login", value: "fixture-token" }] },
      { origin: otherOrigin, localStorage: [{ name: "theme", value: "dark" }] },
    ].sort((a, b) => a.origin.localeCompare(b.origin)));
    await context.clearCookies();
    await context.addCookies(JSON.parse(JSON.stringify(state)).cookies);
    await otherPage.goto(`${url}/again`);
    assert.equal((await context.cookies(url)).find(c => c.name === "server").value, "received");
    assert.equal(await otherPage.evaluate("localStorage.getItem('login')"), "fixture-token");
    const { browserContextId } = await connection.cdp.send("Target.createBrowserContext");
    try {
      const { page: fresh } = await createAgentTabs(connection).create("about:blank", { browserContextId });
      const saved = JSON.parse(readFileSync(path.join(ud, "nested", "state.json"), "utf8"));
      await fresh.context().addCookies(saved.cookies);
      for (const { origin, localStorage } of saved.origins) {
        await fresh.goto(origin);
        await fresh.evaluate(`(${JSON.stringify(localStorage)}).forEach(({ name, value }) => window.localStorage.setItem(name, value))`);
      }
      const restored = await fresh.context().storageState();
      assert.deepEqual(restored.cookies, state.cookies);
      assert.deepEqual(restored.origins.sort((a, b) => a.origin.localeCompare(b.origin)), state.origins);
    } finally {
      await connection.cdp.send("Target.disposeBrowserContext", { browserContextId });
    }
  });
});

test("page contexts isolate cookies storage and newly created pages", { skip: !SHELL, timeout: 60000 }, async () => {
  await withContextFixture(async ({ connection, page, url }) => {
    const { browserContextId } = await connection.cdp.send("Target.createBrowserContext");
    try {
      const { page: isolated } = await createAgentTabs(connection).create("about:blank", { browserContextId });
      const context = isolated.context();
      await isolated.goto(`${url}/set`);
      await isolated.evaluate("localStorage.setItem('private', 'isolated')");
      await context.addCookies([{ name: "private", value: "isolated", url }]);
      assert.deepEqual(await page.context().cookies(), []);
      await page.context().clearCookies();
      assert.equal((await context.cookies()).find(c => c.name === "private").value, "isolated");
      const sibling = await context.newPage();
      assert.equal(sibling.context(), context);
      await sibling.goto(url);
      assert.equal(await sibling.evaluate("localStorage.getItem('private')"), "isolated");
      assert.deepEqual((await page.context().storageState()).origins, []);
      await context.clearCookies({ name: "private" });
      assert.equal((await context.cookies()).some(c => c.name === "private"), false);
    } finally {
      await connection.cdp.send("Target.disposeBrowserContext", { browserContextId });
    }
  });
});

test("sanitizeCookies normalizes raw cookie exports for CDP", () => {
  const raw = [
    { name: "session", value: "abc", domain: "example.com", path: "/", expires: -1, secure: true, httpOnly: true, sameSite: "Lax" },
    { name: "__Host-csrf", value: "xyz", domain: "example.com", path: "/", expires: 1790066399, secure: false, httpOnly: false, sameSite: "None" },
    { name: "pref", value: "1", domain: ".example.com", path: "/", expires: 1790066399, secure: false, httpOnly: false, sameSite: "None" },
    { name: "pref", value: "2", domain: ".example.com", path: "/", expires: 1890066399, secure: false, httpOnly: false },
  ];
  const out = sanitizeCookies(raw);

  const session = out.find(c => c.name === "session");
  assert.equal("expires" in session, false, "negative expires dropped");
  assert.equal(session.sameSite, "Lax");

  const host = out.find(c => c.name === "__Host-csrf");
  assert.equal(host.secure, true, "__Host- forces secure");
  assert.equal(host.path, "/", "__Host- forces root path");
  assert.equal("domain" in host, false, "__Host- uses url, not domain");
  assert.equal(host.url, "https://example.com");
  assert.equal(host.sameSite, "None", "SameSite=None valid once secure is forced");

  const prefs = out.filter(c => c.name === "pref");
  assert.equal(prefs.length, 1, "duplicate name+domain deduped");
  assert.equal(prefs[0].value, "2", "latest expiry wins");
  assert.equal(prefs[0].sameSite, undefined, "SameSite=None without secure dropped");
});

test("injectCookies sets cookies reachable on navigation", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-cookies-test-"));
  const connection = await connectPipe({
    browserPath: SHELL,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
    storageRoot: ud,
  });
  try {
    const page = (await createAgentTabs(connection).create("about:blank")).page;
    await injectCookies(page, [
      { name: "omw_test", value: "works", domain: "example.com", expires: Math.floor(Date.now() / 1000) + 3600 },
      { name: "__Host-pinned", value: "yes", domain: "example.com", expires: Math.floor(Date.now() / 1000) + 3600 },
    ]);
    await page.goto("https://example.com");
    const cookieHeader = await page.evaluate("document.cookie");
    assert.ok(cookieHeader.includes("omw_test=works"), `injected cookie visible: ${cookieHeader}`);
    assert.ok(cookieHeader.includes("__Host-pinned=yes"), `host-pinned cookie visible: ${cookieHeader}`);
  } finally {
    await connection.close();
    removeTreeSync(ud);
  }
});
