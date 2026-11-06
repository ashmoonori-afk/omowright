import { test } from "node:test";
import assert from "node:assert/strict";
import { createNetworkSnoop } from "../src/network-snoop.js";
import { OmOPage } from "../src/core.js";
import { connectPipe } from "../src/pipe.js";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { removeTreeSync } from "./fixtures/remove-tree.mjs";

class FakeCdp {
  constructor() {
    this.calls = [];
    this.bodies = new Map();
    this.listeners = new Map();
  }
  on(method, listener) {
    const set = this.listeners.get(method) ?? new Set();
    set.add(listener);
    this.listeners.set(method, set);
    return () => set.delete(listener);
  }
  emit(method, params, meta = { sessionId: "s1" }) {
    for (const listener of [...this.listeners.get(method) ?? []]) listener(params, meta);
  }
  listenerCount() {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
  async send(method, params, sessionId) {
    this.calls.push({ method, params, sessionId });
    if (method === "Network.getResponseBody") return this.bodies.get(params.requestId) ?? { body: "", base64Encoded: false };
    return {};
  }
}

const fakePage = cdp => ({ cdp, resolveSessionId: async () => "s1" });
// setImmediate is a macrotask boundary: it drains every already-resolved microtask
// the snoop queued (session resolution, body fetches), without waiting on the clock.
const flush = () => new Promise(resolve => setImmediate(resolve));

function sendRequest(cdp, requestId, options = {}, meta) {
  const { url = "https://x.test/api/items", method = "GET", type = "XHR", postData = null } = options;
  cdp.emit("Network.requestWillBeSent", {
    requestId,
    request: { url, method, headers: { accept: "*/*" }, postData },
    type,
    wallTime: 1_700_000_000,
    timestamp: 1234.5,
  }, meta);
}

function sendResponse(cdp, requestId, options = {}, meta) {
  const { status = 200, statusText = "OK", mimeType = "application/json" } = options;
  cdp.emit("Network.responseReceived", {
    requestId,
    type: "XHR",
    response: { status, statusText, mimeType, headers: { "content-type": mimeType }, remoteIPAddress: "127.0.0.1" },
  }, meta);
}

function sendFinished(cdp, requestId, encodedDataLength = 12, meta) {
  cdp.emit("Network.loadingFinished", { requestId, encodedDataLength }, meta);
}

async function roundTrip(cdp, requestId, request = {}, response = {}, encodedDataLength = 12, meta) {
  sendRequest(cdp, requestId, request, meta);
  sendResponse(cdp, requestId, response, meta);
  sendFinished(cdp, requestId, encodedDataLength, meta);
  await flush();
}

test("snoop records a full request lifecycle and fetches the response body", async () => {
  const cdp = new FakeCdp();
  cdp.bodies.set("r1", { body: '{"ok":true}', base64Encoded: false });
  const snoop = createNetworkSnoop(fakePage(cdp));
  await flush();

  await roundTrip(cdp, "r1", { url: "https://x.test/api/items", method: "POST", postData: '{"q":1}' }, {}, 11);

  const entries = snoop.peek();
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.requestId, "r1");
  assert.equal(entry.url, "https://x.test/api/items");
  assert.equal(entry.method, "POST");
  assert.equal(entry.resourceType, "XHR");
  assert.equal(entry.status, 200);
  assert.equal(entry.statusText, "OK");
  assert.equal(entry.mimeType, "application/json");
  assert.deepEqual(entry.requestHeaders, { accept: "*/*" });
  assert.deepEqual(entry.responseHeaders, { "content-type": "application/json" });
  assert.equal(entry.postData, '{"q":1}');
  assert.equal(entry.encodedDataLength, 11);
  assert.equal(entry.body, '{"ok":true}');
  assert.equal(entry.base64Encoded, false);
  assert.equal(entry.bodySkipped, false);
  assert.equal(entry.failed, false);
  assert.equal(entry.errorText, null);
  assert.equal(typeof entry.startedAt, "number");
  assert.ok(entry.finishedAt >= entry.startedAt);

  const bodyCalls = cdp.calls.filter(call => call.method === "Network.getResponseBody");
  assert.equal(bodyCalls.length, 1);
  assert.deepEqual(bodyCalls[0].params, { requestId: "r1" });
  assert.equal(bodyCalls[0].sessionId, "s1");
  assert.equal(snoop.peek().length, 1, "peek does not consume");
  snoop.dispose();
});

test("snoop ignores other CDP sessions and pop consumes once", async () => {
  const cdp = new FakeCdp();
  const snoop = createNetworkSnoop(fakePage(cdp));
  await flush();

  await roundTrip(cdp, "other", { url: "https://other.test/api/items" }, {}, 12, { sessionId: "other" });
  await roundTrip(cdp, "r1", { url: "https://x.test/api/items" });

  const first = snoop.pop();
  assert.equal(first.length, 1);
  assert.equal(first[0].requestId, "r1");
  assert.deepEqual(snoop.pop(), []);
  assert.deepEqual(snoop.peek(), []);
  snoop.dispose();
});

test("popJson parses json bodies and silently drops unparsable or non-json entries", async () => {
  const cdp = new FakeCdp();
  cdp.bodies.set("r1", { body: '[{"id":1}]', base64Encoded: false });
  cdp.bodies.set("r2", { body: "not json at all", base64Encoded: false });
  cdp.bodies.set("r3", { body: "<html></html>", base64Encoded: false });
  cdp.bodies.set("r4", { body: Buffer.from('{"a":2}').toString("base64"), base64Encoded: true });
  const snoop = createNetworkSnoop(fakePage(cdp));
  await flush();

  await roundTrip(cdp, "r1", { url: "https://x.test/api/items" });
  await roundTrip(cdp, "r2", { url: "https://x.test/api/broken" });
  await roundTrip(cdp, "r3", { url: "https://x.test/page" }, { mimeType: "text/html" });
  await roundTrip(cdp, "r4", { url: "https://x.test/api/ld" }, { mimeType: "application/ld+json" });

  assert.deepEqual(snoop.popJson(), [[{ id: 1 }], { a: 2 }]);
  assert.deepEqual(snoop.pop(), [], "popJson drains the buffer");
  snoop.dispose();
});

test("an instance match filters which entries are buffered", async () => {
  const cdp = new FakeCdp();
  const snoop = createNetworkSnoop(fakePage(cdp), {
    match: { url: "/api/", method: "get", mimeType: /json/, resourceType: "xhr" },
    bodies: false,
  });
  await flush();

  await roundTrip(cdp, "r1", { url: "https://x.test/api/items" });
  await roundTrip(cdp, "r2", { url: "https://x.test/page" });
  await roundTrip(cdp, "r3", { url: "https://x.test/api/items", method: "POST" });
  await roundTrip(cdp, "r4", { url: "https://x.test/api/items" }, { mimeType: "text/html" });

  assert.deepEqual(snoop.pop().map(entry => entry.requestId), ["r1"]);
  snoop.dispose();
});

test("waitFor resolves on a later matching entry and rejects on timeout", async () => {
  const cdp = new FakeCdp();
  cdp.bodies.set("r2", { body: '{"ok":true}', base64Encoded: false });
  const snoop = createNetworkSnoop(fakePage(cdp));
  await flush();

  await roundTrip(cdp, "r0", { url: "https://x.test/api/click" });
  const pending = snoop.waitFor({ url: "/api/click" }, { timeoutMs: 5000 });
  await roundTrip(cdp, "r1", { url: "https://x.test/api/items" });
  await roundTrip(cdp, "r2", { url: "https://x.test/api/click" });

  const entry = await pending;
  assert.equal(entry.requestId, "r2", "only entries finishing after the call resolve the waiter");
  assert.equal(entry.body, '{"ok":true}');

  await assert.rejects(
    snoop.waitFor(candidate => candidate.url.includes("never-happens"), { timeoutMs: 20 }),
    error => error.message.startsWith("Timed out waiting for network response"),
  );
  snoop.dispose();
});

test("summary prints one line per entry, oldest first, and truncates", async () => {
  const cdp = new FakeCdp();
  const snoop = createNetworkSnoop(fakePage(cdp), { bodies: false });
  await flush();

  await roundTrip(cdp, "r1", { url: "https://x.test/api/1" }, {}, 120);
  await roundTrip(cdp, "r2", { url: "https://x.test/api/2", method: "POST" }, { status: 404, statusText: "Not Found" }, 33);
  await roundTrip(cdp, "r3", { url: "https://x.test/api/3" }, { mimeType: "text/html" }, 7);

  assert.equal(snoop.summary(), [
    "GET 200 application/json 120B https://x.test/api/1",
    "POST 404 application/json 33B https://x.test/api/2",
    "GET 200 text/html 7B https://x.test/api/3",
  ].join("\n"));
  assert.equal(snoop.summary({ max: 2 }), [
    "GET 200 application/json 120B https://x.test/api/1",
    "POST 404 application/json 33B https://x.test/api/2",
    "... +1 more",
  ].join("\n"));
  snoop.dispose();
});

test("maxEntries evicts the oldest entries and bodies:false skips body fetches", async () => {
  const cdp = new FakeCdp();
  const snoop = createNetworkSnoop(fakePage(cdp), { maxEntries: 2, bodies: false });
  await flush();

  await roundTrip(cdp, "r1", { url: "https://x.test/api/1" });
  await roundTrip(cdp, "r2", { url: "https://x.test/api/2" });
  await roundTrip(cdp, "r3", { url: "https://x.test/api/3" });

  assert.deepEqual(snoop.peek().map(entry => entry.requestId), ["r2", "r3"]);
  assert.equal(cdp.calls.filter(call => call.method === "Network.getResponseBody").length, 0);
  snoop.dispose();
});

test("oversized bodies are skipped and failed requests are recorded", async () => {
  const cdp = new FakeCdp();
  cdp.bodies.set("r1", { body: "x".repeat(50), base64Encoded: false });
  const snoop = createNetworkSnoop(fakePage(cdp), { maxBodyBytes: 10 });
  await flush();

  await roundTrip(cdp, "r1", { url: "https://x.test/api/big" }, {}, 999);
  sendRequest(cdp, "r2", { url: "https://x.test/api/dead" });
  cdp.emit("Network.loadingFailed", { requestId: "r2", errorText: "net::ERR_ABORTED", encodedDataLength: 0 });
  await flush();

  const [big, dead] = snoop.pop();
  assert.equal(big.bodySkipped, true);
  assert.equal(big.body, null);
  assert.equal(cdp.calls.filter(call => call.method === "Network.getResponseBody").length, 0);
  assert.equal(dead.failed, true);
  assert.equal(dead.errorText, "net::ERR_ABORTED");
  assert.equal(dead.status, null);
  snoop.dispose();
});

test("dispose rejects pending waiters and removes every subscription", async () => {
  const cdp = new FakeCdp();
  const snoop = createNetworkSnoop(fakePage(cdp));
  await flush();
  assert.ok(cdp.listenerCount() >= 4);

  const pending = snoop.waitFor({ url: "/never" }, { timeoutMs: 5000 });
  snoop.dispose();
  await assert.rejects(pending, /disposed/);
  assert.equal(cdp.listenerCount(), 0);
  snoop.dispose();
});

for (const method of ["waitForRequest", "waitForResponse"]) {
  for (const [name, match, rejected, accepted] of [
    ["exact", "https://x.test/api/items", "https://x.test/api/items/extra", "https://x.test/api/items"],
    ["single star", "https://x.test/api/*", "https://x.test/api/nested/items", "https://x.test/api/items"],
    ["double star", "**/api/**", "https://x.test/other/items", "https://x.test/api/nested/items"],
    ["query string", "**/api/items?kind=*", "https://x.test/api/itemsXkind=one", "https://x.test/api/items?kind=one"],
    ["query alternatives", "**/api/{items,users}?page=2", "https://x.test/api/items?page=1", "https://x.test/api/users?page=2"],
  ]) {
    test(`${method} uses Playwright URL globs: ${name}`, async () => {
      const cdp = new FakeCdp();
      const page = new OmOPage(cdp, {
        mainFrameId: "f1", getFrame: () => null, frames: new Map(),
      }, "t1", "s1", { resolvePageSession: async () => "s1" });
      try {
        const pending = page[method](match, { timeout: 1000 });
        await roundTrip(cdp, "rejected", { url: rejected });
        await roundTrip(cdp, "accepted", { url: accepted });
        assert.equal((await pending).url(), accepted);
      } finally {
        await page.dispose();
      }
    });
  }
}

test("page network objects reject refused bodies and unsubscribe on disposal", async () => {
  const cdp = new FakeCdp();
  const page = new OmOPage(cdp, {
    mainFrameId: "f1", getFrame: () => null, frames: new Map(),
  }, "t1", "s1", { resolvePageSession: async () => "s1" });
  const snoop = createNetworkSnoop(page, { bodies: false });
  try {
    const pending = page.waitForResponse("https://x.test/api/items", { timeout: 1000 });
    await flush();
    sendRequest(cdp, "r1");
    sendResponse(cdp, "r1");
    const response = await pending;
    const original = cdp.send.bind(cdp);
    let reads = 0;
    cdp.send = async (...args) => {
      if (args[0] === "Network.getResponseBody") {
        reads++;
        throw Error("transport refuses response bodies");
      }
      return original(...args);
    };
    const body = response.body();
    await flush();
    assert.equal(reads, 0, "body reads wait until the transfer finishes");
    sendFinished(cdp, "r1");
    await assert.rejects(body, error => error.name === "NetworkBodyUnavailableError"
      && error.cause.message === "transport refuses response bodies");
    await assert.rejects(response.text(), { name: "NetworkBodyUnavailableError" });
    await assert.rejects(response.json(), { name: "NetworkBodyUnavailableError" });
    assert.equal(reads, 1, "body readers share one transport result");
    assert.equal(snoop.peek().length, 1);
  } finally {
    snoop.dispose();
    await page.dispose();
  }
  assert.equal(cdp.listenerCount(), 0);
});

test("network ownership is lazy, shared, and released even when enable is refused", async () => {
  const cdp = new FakeCdp();
  const original = cdp.send.bind(cdp);
  cdp.send = async (...args) => {
    const result = await original(...args);
    if (args[0] === "Network.enable") throw Error("enable refused");
    return result;
  };
  const page = new OmOPage(cdp, {
    mainFrameId: "f1", getFrame: () => null, frames: new Map(),
  }, "t1", "s1", { resolvePageSession: async () => "s1" });
  const baseline = cdp.listenerCount();
  assert.equal(cdp.calls.length, 0, "page setup enables no Network or Runtime domain");
  const request = () => {};
  const response = () => {};
  const off = page.on("request", request);
  page.on("response", response);
  const snoop = createNetworkSnoop(page, { bodies: false });
  await flush();
  assert.equal(cdp.calls.filter(call => call.method === "Network.enable").length, 1);
  assert.equal(cdp.listenerCount(), baseline + 4, "one shared CDP path");
  off(); off();
  page.off("response", response);
  assert.equal(cdp.calls.filter(call => call.method === "Network.disable").length, 0);
  snoop.dispose();
  assert.equal(cdp.calls.filter(call => call.method === "Network.disable").length, 1);
  assert.equal(cdp.listenerCount(), baseline);
  const error = Error("bad predicate");
  const pending = page.waitForRequest(() => { throw error; }, { timeout: 1000 });
  await flush();
  sendRequest(cdp, "r1");
  await assert.rejects(pending, value => value === error);
  assert.equal(cdp.listenerCount(), baseline, "rejected predicates release their listeners");
  await page.dispose();
  assert.equal(cdp.listenerCount(), 0);
});

test("response body decoding survives automatic wait listener removal", async () => {
  const cdp = new FakeCdp();
  cdp.bodies.set("r1", { body: Buffer.from("binary \u00e9").toString("base64"), base64Encoded: true });
  const page = new OmOPage(cdp, {
    mainFrameId: "f1", getFrame: () => null, frames: new Map(),
  }, "t1", "s1", { resolvePageSession: async () => "s1" });
  try {
    const pending = page.waitForResponse(/api\/items$/g, { timeout: 1000 });
    await flush();
    sendRequest(cdp, "r1");
    sendResponse(cdp, "r1");
    const response = await pending;
    assert.equal(cdp.calls.filter(call => call.method === "Network.disable").length, 0);
    sendFinished(cdp, "r1");
    await flush();
    assert.equal(cdp.calls.filter(call => call.method === "Network.disable").length, 1);
    assert.equal(await response.text(), "binary \u00e9");
    assert.deepEqual(await response.body(), Buffer.from("binary \u00e9"));
  } finally {
    await page.dispose();
  }
});

test("page waits and events observe local HTTP traffic with readable bodies", {
  skip: !process.env.SHELL_BIN && "set SHELL_BIN to a Chromium headless shell", timeout: 60_000,
}, async () => {
  const server = createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Network fixture</title><main>Network fixture</main>");
    } else {
      response.writeHead(201, { "content-type": "application/json", "x-fixture": "network" });
      response.end('{"ok":true}');
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(path.join(tmpdir(), "omowright-network-"));
  let browser;
  try {
    browser = await connectPipe({
      browserPath: process.env.SHELL_BIN,
      browserArgs: ["--headless", `--user-data-dir=${dir}`], storageRoot: dir,
    });
    const page = await browser.newTab("about:blank");
    await page.goto(origin + "/", { waitUntil: "load" });
    const events = [];
    const requestListener = value => events.push(["request", value]);
    const responseListener = value => events.push(["response", value]);
    page.on("request", requestListener);
    page.on("response", responseListener);
    const snoop = createNetworkSnoop(page);
    try {
      const requestWait = page.waitForRequest(origin + "/api", { timeout: 10_000 });
      const responseWait = page.waitForResponse(origin + "/api", { timeout: 10_000 });
      const predicateWait = page.waitForResponse(async response =>
        response.url().endsWith("/api") && response.status() === 201, { timeout: 10_000 });
      const captured = snoop.waitFor({ url: "/api" }, { timeoutMs: 10_000 });
      await page.evaluate(() => fetch("/api", {
        method: "POST", headers: { "x-request": "yes" }, body: '{"query":1}',
      }).then(response => response.text()));
      const [request, response, predicate, entry] = await Promise.all([
        requestWait, responseWait, predicateWait, captured,
      ]);
      assert.deepEqual(events.map(([name]) => name), ["request", "response"]);
      assert.equal(events[0][1], request);
      assert.equal(events[1][1], response);
      assert.equal(predicate, response);
      assert.equal(request.url(), origin + "/api");
      assert.equal(request.method(), "POST");
      assert.equal(request.headers()["x-request"], "yes");
      assert.deepEqual(await request.json(), { query: 1 });
      assert.equal(response.method(), "POST");
      assert.equal(response.status(), 201);
      assert.equal(response.headers()["x-fixture"], "network");
      assert.deepEqual(await response.json(), { ok: true });
      assert.equal(await response.text(), '{"ok":true}');
      assert.deepEqual(await response.body(), Buffer.from('{"ok":true}'));
      assert.equal(entry.body, '{"ok":true}');
      page.off("request", requestListener);
      page.off("response", responseListener);
      const later = page.waitForRequest(request => request.url().endsWith("/later"), { timeout: 10_000 });
      await page.evaluate(() => fetch("/later").then(response => response.text()));
      assert.equal((await later).method(), "GET");
      assert.equal(events.length, 2);
      for (const method of ["waitForRequest", "waitForResponse"]) {
        await assert.rejects(page[method](origin + "/never", { timeout: 10 }), /Timed out/);
      }
      const original = page.cdp.send.bind(page.cdp);
      page.cdp.send = async (...args) => {
        if (args[0] === "Network.getResponseBody") throw Error("response bodies refused");
        return original(...args);
      };
      try {
        const refused = page.waitForResponse(origin + "/refused", { timeout: 10_000 });
        await page.evaluate(() => fetch("/refused").then(response => response.text()));
        await assert.rejects((await refused).body(), { name: "NetworkBodyUnavailableError" });
      } finally {
        page.cdp.send = original;
      }
    } finally {
      snoop.dispose();
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    removeTreeSync(dir);
  }
});

// Chromium protocol contract: the renderer reports a cross-document commit before the browser activates the document,
// and browser-side page commands fail with "Not attached to an active page" until then. Chromium holds renderer-bound
// commands until the navigation finishes, so a history step settles on a frame-tree reply requested after the commit.
test("history steps settle on a frame-tree reply requested after the cross-document commit", async () => {
  const cdp = new FakeCdp();
  const history = { currentIndex: 1, entries: [{ id: 1, url: "https://x.test/a" }, { id: 2, url: "https://x.test/b" }] };
  const frameTree = Promise.withResolvers();
  const original = cdp.send.bind(cdp);
  cdp.send = async (...args) => {
    const result = await original(...args);
    if (args[0] === "Page.getNavigationHistory") return history;
    return args[0] === "Page.getFrameTree" ? frameTree.promise : result;
  };
  const frameTreeRequests = () => cdp.calls.filter(call => call.method === "Page.getFrameTree").length;
  const page = new OmOPage(cdp, {
    mainFrameId: "f1", getFrame: () => null, frames: new Map(), hasSession: () => true,
  }, "t1", "s1", { resolvePageSession: async () => "s1" });
  try {
    let settled = false;
    const back = page.goBack().then(response => {
      settled = true;
      return response;
    });
    await flush();
    cdp.emit("Network.requestWillBeSent", {
      requestId: "l1", loaderId: "l1", frameId: "f1", type: "Document",
      request: { url: "https://x.test/a", method: "GET", headers: {} },
    });
    cdp.emit("Network.responseReceived", { requestId: "l1", type: "Document", response: { status: 200, headers: {} } });
    await flush();
    assert.equal(frameTreeRequests(), 0, "a request before the commit would be answered before the navigation");
    cdp.emit("Page.frameNavigated", { frame: { id: "f1", loaderId: "l1", url: "https://x.test/a" }, type: "Navigation" });
    await flush();
    assert.equal(settled, false, "the renderer's commit alone does not settle the step");
    assert.equal(frameTreeRequests(), 1);
    frameTree.resolve({ frameTree: { frame: { id: "f1" } } });
    assert.equal((await back).status(), 200);
  } finally {
    await page.dispose();
  }
});

// Public API contract (Playwright parity): navigations resolve with the main frame's final document response,
// or null when the navigation stays in the same document or there is no history entry.
test("navigation methods resolve with the main-frame document response", {
  skip: !process.env.SHELL_BIN && "set SHELL_BIN to a Chromium headless shell", timeout: 60_000,
}, async () => {
  const server = createServer((request, response) => {
    if (request.url === "/moved") {
      response.writeHead(302, { location: "/" });
      response.end();
      return;
    }
    const status = request.url === "/missing" ? 404 : 200;
    response.writeHead(status, { "content-type": "text/html", "x-fixture": request.url });
    response.end(`<!doctype html><title>${status}</title><main>Navigation fixture ${request.url}</main>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(path.join(tmpdir(), "omowright-navigation-"));
  let browser;
  try {
    browser = await connectPipe({
      browserPath: process.env.SHELL_BIN,
      browserArgs: ["--headless", `--user-data-dir=${dir}`], storageRoot: dir,
    });
    const page = await browser.newTab("about:blank");
    const ok = await page.goto(origin + "/", { waitUntil: "load" });
    assert.equal(ok.status(), 200);
    assert.equal(ok.ok(), true);
    assert.equal(ok.url(), origin + "/");
    assert.equal(ok.headers()["x-fixture"], "/");
    assert.equal(await ok.text(), "<!doctype html><title>200</title><main>Navigation fixture /</main>");

    const missing = await page.goto(origin + "/missing", { waitUntil: "load" });
    assert.equal(missing.status(), 404);
    assert.equal(missing.ok(), false);
    assert.equal(await page.goto(origin + "/missing#details", { waitUntil: "domcontentloaded" }), null);

    assert.equal(await page.goBack(), null, "back within the document");
    const back = await page.goBack();
    assert.equal(back.url(), origin + "/");
    assert.equal(back.status(), 200);
    assert.equal((await page.goForward()).status(), 404);
    assert.equal(await page.goForward(), null, "forward within the document");
    assert.equal(await page.goForward(), null, "no forward entry");
    const reloaded = await page.reload();
    assert.equal(reloaded.status(), 404);
    assert.equal(reloaded.headers()["x-fixture"], "/missing");

    // Last step: a commit-mode goto returns before the document is active, and its body is read after the call.
    const redirected = await page.goto(origin + "/moved", { waitUntil: "commit" });
    assert.equal(redirected.url(), origin + "/");
    assert.equal(redirected.status(), 200);
    assert.equal(await redirected.text(), "<!doctype html><title>200</title><main>Navigation fixture /</main>");
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    removeTreeSync(dir);
  }
});

