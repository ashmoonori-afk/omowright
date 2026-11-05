// Protocol contract: a scoped CDP endpoint that allows only OMOWRIGHT_PAGE_CDP_METHODS and requires a Bearer token
// is enough for the page API. This fake forwards Target.* to the real browser; scoping them per thread is the
// endpoint's job (tested in the OmO desktop app). A new command in the page path, or a token sent outside the Authorization header,
// fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, existsSync, globSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { CdpClient, OMOWRIGHT_PAGE_CDP_METHODS, compactSnapshot, connect, createAgentTabs } from "../src/index.js";
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
const ALLOWED = new Set(OMOWRIGHT_PAGE_CDP_METHODS);
const GOOD = "Bearer scoped-good";

const PAGE = `<!doctype html><title>Scoped</title>
<label>Name <input id="name"></label>
<button onclick="document.getElementById('out').textContent = 'hi ' + document.getElementById('name').value">Greet</button>
<p id="out"></p>`;

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

async function launchChromium(userDataDir) {
  const child = spawn(SHELL, ["--headless", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${userDataDir}`, "about:blank"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const wsUrl = await new Promise((resolve, reject) => {
    let buffered = "";
    child.stderr.on("data", (chunk) => {
      buffered += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffered);
      if (match) resolve(match[1]);
    });
    child.once("exit", (code) => reject(new Error(`chromium exited early (${code})`)));
  });
  return { child, wsUrl, httpBase: wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/.*$/, "") };
}

// The endpoint under test: answers discovery, demands the Bearer token on every request and the upgrade, and
// forwards only allowlisted methods to the real browser.
async function startScopedEndpoint(upstream, { refuseRuntime = false } = {}) {
  const commands = [];
  const events = new EventEmitter();
  const refused = [];
  const unauthorized = [];
  const authorized = (req) => {
    if (req.headers.authorization === GOOD && !req.url.includes("token")) return true;
    unauthorized.push(req.url);
    return false;
  };
  const server = createServer(async (req, res) => {
    if (!authorized(req)) {
      res.writeHead(401).end("Unauthorized");
      return;
    }
    const port = server.address().port;
    if (req.url === "/json/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ Browser: "Scoped/1", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/scoped` }));
      return;
    }
    if (req.url === "/json/list") {
      const targets = await (await fetch(`${upstream.httpBase}/json/list`)).json();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(targets.filter((t) => t.type === "page").map(({ webSocketDebuggerUrl: _ws, devtoolsFrontendUrl: _fe, ...t }) => t)));
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (!authorized(req)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      const browser = new WebSocket(upstream.wsUrl);
      const pending = [];
      browser.on("open", () => pending.splice(0).forEach((m) => browser.send(m)));
      browser.on("message", (data) => client.send(data.toString()));
      browser.on("close", () => client.close());
      client.on("close", () => browser.close());
      client.on("message", (data) => {
        const message = JSON.parse(data.toString());
        commands.push(message.method);
        events.emit(message.method, message);
        if (!ALLOWED.has(message.method) || (refuseRuntime && message.method === "Runtime.enable")) {
          refused.push(message.method);
          client.send(JSON.stringify({ id: message.id, sessionId: message.sessionId, error: { code: -32601, message: `'${message.method}' wasn't found` } }));
          return;
        }
        if (browser.readyState === WebSocket.OPEN) browser.send(data.toString());
        else pending.push(data.toString());
      });
    });
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, commands, events, refused, unauthorized, close: () => new Promise((r) => { wss.close(); server.close(() => r()); }) };
}

test("the page API runs through an endpoint that allows only OMOWRIGHT_PAGE_CDP_METHODS", { skip: !SHELL && "no chromium binary found", timeout: 90000 }, async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "omowright-scoped-"));
  const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(PAGE));
  const sitePort = await listen(site);
  const upstream = await launchChromium(userDataDir);
  const endpoint = await startScopedEndpoint(upstream);
  const forceRefreshes = [];
  let token = "Bearer scoped-stale";
  let connection;
  try {
    connection = await connect(endpoint.url, {
      storageRoot: userDataDir,
      client: {
        authorizer: {
          // A stale token first: the endpoint answers 401 and OmOWright must ask again with forceRefresh.
          resolveAuthorization: async ({ forceRefresh } = {}) => {
            forceRefreshes.push(Boolean(forceRefresh));
            if (forceRefresh) token = GOOD;
            return token;
          },
        },
      },
    });
    const { page } = await createAgentTabs(connection).create("about:blank");
    assert.equal(endpoint.commands.filter(method => method === "Runtime.enable").length, 0, "page setup without console listeners must not enable Runtime");
    await page.goto(`http://127.0.0.1:${sitePort}/`);
    const snapshot = compactSnapshot(await page.snapshot());
    assert.match(snapshot, /button "Greet"/);
    await page.locator("#name").fill("scoped");
    await page.getByRole("button", { name: "Greet" }).click();
    assert.equal(await page.evaluate("document.getElementById('out').textContent"), "hi scoped");
    const shot = await page.screenshot({ path: "scoped.png" });
    assert.ok(shot, "screenshot taken");

    assert.deepEqual(endpoint.refused, [], `methods outside OMOWRIGHT_PAGE_CDP_METHODS: ${endpoint.refused.join(", ")}`);
    assert.ok(forceRefreshes.includes(true), "a 401 makes the authorizer refresh");
    assert.ok(endpoint.unauthorized.length > 0, "the stale token was refused");
    const enabled = once(endpoint.events, "Runtime.enable", { signal: AbortSignal.timeout(5000) });
    const firstListener = () => {};
    const secondListener = () => {};
    const removeFirst = page.on("console", firstListener);
    await enabled;
    page.on("console", secondListener);
    removeFirst();
    await page.evaluate("console.log('second listener still active')");
    assert.equal(endpoint.commands.filter(method => method === "Runtime.enable").length, 1);
    assert.equal(endpoint.commands.filter(method => method === "Runtime.disable").length, 0);
    const disabled = once(endpoint.events, "Runtime.disable", { signal: AbortSignal.timeout(5000) });
    page.off("console", secondListener);
    await disabled;
    assert.equal(endpoint.commands.filter(method => method === "Runtime.disable").length, 1);
  } finally {
    await connection?.close().catch(() => {});
    await endpoint.close();
    const exited = upstream.child.exitCode === null ? once(upstream.child, "exit") : Promise.resolve();
    upstream.child.kill();
    await exited;
    site.close();
    removeTreeSync(userDataDir);
  }
});

// Optional console capture must not turn an older endpoint's Runtime refusal into a page setup failure.
test("page setup and evaluation survive an endpoint refusing Runtime.enable", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), "omowright-runtime-refusal-"));
  const upstream = await launchChromium(userDataDir);
  const endpoint = await startScopedEndpoint(upstream, { refuseRuntime: true });
  let connection;
  try {
    connection = await connect(endpoint.url, { storageRoot: userDataDir, client: { authorizer: { resolveAuthorization: async () => GOOD } } });
    const { page } = await createAgentTabs(connection).create("about:blank");
    assert.equal(await page.evaluate("21 * 2"), 42);
    const refused = once(endpoint.events, "Runtime.enable", { signal: AbortSignal.timeout(5000) });
    const remove = page.on("console", () => {});
    await refused;
    assert.equal(await page.evaluate("6 * 7"), 42, "Runtime refusal must not poison later commands");
    remove();
    assert.deepEqual(endpoint.refused, ["Runtime.enable"]);
  } finally {
    await connection?.close().catch(() => {});
    await endpoint.close();
    const exited = upstream.child.exitCode === null ? once(upstream.child, "exit") : Promise.resolve();
    upstream.child.kill();
    await exited;
    removeTreeSync(userDataDir);
  }
});


// Security contract (#75): a CdpClient has no default endpoint. 127.0.0.1:9222 is where a user's own Chrome listens
// once remote debugging is enabled from chrome://inspect, so a missing URL must refuse, never dial a browser there.
// fetch is intercepted at the global boundary, so an HTTP discovery dial is recorded and blocked. WebSocket is not:
// src/core.js imports ws directly, so a direct ws:// dial bypasses any global stub; such a regression fails on the
// "refused" outcomes, which the constructor must produce before it dials anything.
// The 15 s budget only matters on a regression: an unrefused client walks its full reconnect schedule (~5.5 s).
test("a CdpClient without a URL refuses and dials nothing", { timeout: 15_000 }, async () => {
  const dialed = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    dialed.push(String(url));
    throw new Error("network blocked by test");
  };
  const outcomes = [];
  try {
    for (const options of [undefined, { reconnectDelaysMs: [0] }, { cdpUrl: "", reconnectDelaysMs: [0] }]) {
      try {
        const client = new CdpClient(options);
        await client.ensureConnected().catch(() => {});
        await client.close();
        outcomes.push("constructed");
      } catch (error) {
        outcomes.push(error instanceof TypeError && /requires a cdpUrl/.test(error.message) ? "refused" : String(error));
      }
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual({ outcomes, dialed }, { outcomes: ["refused", "refused", "refused"], dialed: [] });
});

// Contract owner: close() ends a CdpClient. A reconnect already in flight when
// close() runs must neither install its socket nor keep retrying: a closed
// client that reconnects holds its caller's process open and, through a port,
// can reach whatever process holds that port by then (#101 review).
for (const reopen of [false, true]) {
  test(`close during discovery ${reopen ? "allows a fresh connection" : "opens no socket and logs no reconnect warning"}`, { timeout: 5_000 }, async () => {
    const realWarn = console.warn;
    const discovered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const warnings = [];
    let requests = 0;
    const server = createServer(async (_req, res) => {
      if (++requests === 2) {
        discovered.resolve();
        await release.promise;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/test` }));
    });
    const sockets = new WebSocketServer({ noServer: true });
    let upgrades = 0;
    server.on("upgrade", (req, socket, head) => {
      upgrades++;
      sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit("connection", ws));
    });
    sockets.on("connection", (ws) => {
      ws.on("message", (data) => {
        const { id } = JSON.parse(data);
        ws.send(JSON.stringify({ id, result: {} }));
      });
    });
    const port = await listen(server);
    console.warn = (...args) => warnings.push(args);
    const client = new CdpClient({ cdpUrl: `http://127.0.0.1:${port}`, reconnectDelaysMs: [0] });
    try {
      await client.ensureConnected();
      [...sockets.clients][0].terminate();
      await discovered.promise;
      // Join only to observe when the old background attempt settles.
      const stale = client.ensureConnected().catch((error) => error);
      await client.close();
      const fresh = reopen ? client.ensureConnected() : Promise.resolve();
      // Attach the rejection handler before releasing the stale attempt.
      const outcome = Promise.allSettled([fresh]);
      release.resolve();
      await stale;
      const [result] = await outcome;
      assert.equal(result.status, "fulfilled", String(result.reason));
      assert.equal(client.isConnected, reopen);
      assert.equal(upgrades, reopen ? 2 : 1, "stale discovery must not open a socket");
      assert.deepEqual(warnings, [], "deliberate close must not warn");
    } finally {
      release.resolve();
      await client.close();
      for (const ws of sockets.clients) ws.terminate();
      sockets.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      console.warn = realWarn;
    }
  });
}

test("a CdpClient closed while it is reconnecting stays closed", { timeout: 15_000 }, async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/reconnect` }));
  });
  const sockets = new WebSocketServer({ noServer: true });
  let held;
  const reconnectArrived = new Promise((resolve) => {
    let upgrades = 0;
    server.on("upgrade", (req, socket, head) => {
      upgrades += 1;
      const accept = () => sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit("connection", ws));
      if (upgrades === 1) accept();
      else { held = accept; resolve(); }
    });
  });
  const first = once(sockets, "connection");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new CdpClient({ cdpUrl: `http://127.0.0.1:${server.address().port}` });
  try {
    await client.ensureConnected();
    const [browserEnd] = await first;
    browserEnd.terminate();
    await reconnectArrived;
    await client.close();
    const late = once(sockets, "connection");
    held();
    const [lateEnd] = await late;
    await once(lateEnd, "close");
    assert.equal(client.isConnected, false);
  } finally {
    await client.close();
    for (const ws of sockets.clients) ws.terminate();
    sockets.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
