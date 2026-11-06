import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoutes } from "../src/routes.js";
import { OmOPage } from "../src/core.js";

class FakeEmitter {
  #listeners = new Map();
  on(name, listener) {
    const set = this.#listeners.get(name) ?? new Set();
    set.add(listener);
    this.#listeners.set(name, set);
    return () => set.delete(listener);
  }
  emit(name, ...args) {
    for (const listener of [...this.#listeners.get(name) ?? []]) listener(...args);
  }
}

class FakeCdp {
  constructor() {
    this.calls = [];
    this.events = new FakeEmitter();
  }
  async send(method, params, sessionId, options) {
    this.calls.push({ method, params, sessionId, options });
    return {};
  }
  on(method, listener) {
    return this.events.on(method, listener);
  }
  emit(method, params, meta = {}) {
    this.events.emit(method, params, meta);
  }
}

function fakePage(sessionId = "sess-1") {
  const cdp = new FakeCdp();
  return { cdp, resolveSessionId: async () => sessionId };
}

function paused(url, extra = {}) {
  return {
    requestId: extra.requestId ?? "req-1",
    resourceType: extra.resourceType ?? "XHR",
    request: {
      url,
      method: extra.method ?? "GET",
      headers: extra.headers ?? { accept: "*/*" },
      postData: extra.postData,
    },
  };
}

function callsOf(page, method) {
  return page.cdp.calls.filter(call => call.method === method);
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("route() sends Fetch.enable once; dispose sends Fetch.disable", async () => {
  const page = fakePage();
  const routes = createRoutes(page);
  assert.equal(routes.enabled, false);
  assert.equal(page.cdp.calls.length, 0);

  await routes.route("*.png", () => {});
  await routes.route("/other", () => {});

  const enables = callsOf(page, "Fetch.enable");
  assert.equal(enables.length, 1);
  assert.deepEqual(enables[0].params, { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  assert.equal(enables[0].sessionId, "sess-1");
  assert.equal(routes.enabled, true);

  await routes.dispose();
  const disables = callsOf(page, "Fetch.disable");
  assert.equal(disables.length, 1);
  assert.equal(disables[0].sessionId, "sess-1");
  assert.equal(routes.enabled, false);

  await routes.dispose();
  assert.equal(callsOf(page, "Fetch.disable").length, 1);
});

test("matching glob fulfill sends Fetch.fulfillRequest with base64 body and content-type", async () => {
  const page = fakePage();
  const routes = createRoutes(page);
  const seen = [];
  await routes.route("*.png", route => {
    seen.push(route.request);
    return route.fulfill({ contentType: "text/plain", body: "hello" });
  });

  page.cdp.emit("Fetch.requestPaused", paused("https://cdn.example/photo.png", { resourceType: "Image" }), { sessionId: "sess-1" });
  await flush();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://cdn.example/photo.png");
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].resourceType, "Image");

  const fulfill = callsOf(page, "Fetch.fulfillRequest");
  assert.equal(fulfill.length, 1);
  assert.equal(fulfill[0].sessionId, "sess-1");
  assert.equal(fulfill[0].params.requestId, "req-1");
  assert.equal(fulfill[0].params.responseCode, 200);
  assert.equal(fulfill[0].params.body, Buffer.from("hello").toString("base64"));
  assert.ok(
    fulfill[0].params.responseHeaders.some(header => header.name.toLowerCase() === "content-type" && header.value === "text/plain"),
    "content-type header is present",
  );

  await routes.dispose();
});

test("abort sends Fetch.failRequest; unmatched continue; other sessionId ignored", async () => {
  const page = fakePage();
  const routes = createRoutes(page);
  let handled = 0;
  await routes.route("*/blocked", route => {
    handled += 1;
    return route.abort();
  });

  page.cdp.emit("Fetch.requestPaused", paused("https://example.test/blocked", { requestId: "abort-1" }), { sessionId: "sess-1" });
  await flush();
  const fail = callsOf(page, "Fetch.failRequest");
  assert.equal(handled, 1);
  assert.equal(fail.length, 1);
  assert.equal(fail[0].params.requestId, "abort-1");
  assert.equal(fail[0].params.errorReason, "Failed");
  assert.equal(fail[0].sessionId, "sess-1");

  page.cdp.emit("Fetch.requestPaused", paused("https://example.test/other", { requestId: "cont-1" }), { sessionId: "sess-1" });
  await flush();
  const cont = callsOf(page, "Fetch.continueRequest");
  assert.equal(cont.length, 1);
  assert.equal(cont[0].params.requestId, "cont-1");
  assert.equal(cont[0].sessionId, "sess-1");

  const before = page.cdp.calls.length;
  page.cdp.emit("Fetch.requestPaused", paused("https://example.test/blocked", { requestId: "other-sess" }), { sessionId: "sess-other" });
  await flush();
  assert.equal(page.cdp.calls.length, before);
  assert.equal(handled, 1);

  await routes.dispose();
});

test("RegExp, substring, and predicate matches; first handler wins; requestId acted once", async () => {
  const page = fakePage();
  const routes = createRoutes(page);
  const hits = [];
  await routes.route(/api\/v1/, route => {
    hits.push("regex");
    return route.fulfill({ body: "regex" });
  });
  await routes.route("example.test/item", route => {
    hits.push("substr");
    return route.fulfill({ body: "substr" });
  });
  await routes.route(({ method, resourceType }) => method === "POST" && resourceType === "Fetch", route => {
    hits.push("pred");
    return route.fulfill({ body: "pred" });
  });
  await routes.route("*", route => {
    hits.push("star");
    return route.continue();
  });

  page.cdp.emit("Fetch.requestPaused", paused("https://example.test/api/v1/x", { requestId: "r-regex" }), { sessionId: "sess-1" });
  page.cdp.emit("Fetch.requestPaused", paused("https://example.test/item/42", { requestId: "r-sub" }), { sessionId: "sess-1" });
  page.cdp.emit("Fetch.requestPaused", paused("https://example.test/submit", { requestId: "r-pred", method: "POST", resourceType: "Fetch" }), { sessionId: "sess-1" });
  await flush();

  assert.deepEqual(hits, ["regex", "substr", "pred"]);
  const bodies = callsOf(page, "Fetch.fulfillRequest").map(call => Buffer.from(call.params.body, "base64").toString());
  assert.deepEqual(bodies, ["regex", "substr", "pred"]);
  assert.equal(callsOf(page, "Fetch.continueRequest").length, 0);

  const fulfillCount = callsOf(page, "Fetch.fulfillRequest").length;
  const page2 = fakePage();
  const routes2 = createRoutes(page2);
  await routes2.route("*", route => {
    route.fulfill({ body: "a" });
    route.abort();
    route.continue();
  });
  page2.cdp.emit("Fetch.requestPaused", paused("https://x.test/", { requestId: "once" }), { sessionId: "sess-1" });
  await flush();
  assert.equal(callsOf(page2, "Fetch.fulfillRequest").length, 1);
  assert.equal(callsOf(page2, "Fetch.failRequest").length, 0);
  assert.equal(callsOf(page2, "Fetch.continueRequest").length, 0);
  assert.equal(fulfillCount, 3);

  await routes.dispose();
  await routes2.dispose();
});

test("handler that throws or settles without an action continues once per request and warns once per handler", async () => {
  const page = fakePage();
  const routes = createRoutes(page);
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const silent = () => {};
    const boom = () => { throw new Error("handler boom"); };
    await routes.route("*/silent", silent);
    await routes.route("*/boom", boom);

    page.cdp.emit("Fetch.requestPaused", paused("https://example.test/silent", { requestId: "s1" }), { sessionId: "sess-1" });
    page.cdp.emit("Fetch.requestPaused", paused("https://example.test/silent", { requestId: "s2" }), { sessionId: "sess-1" });
    page.cdp.emit("Fetch.requestPaused", paused("https://example.test/boom", { requestId: "b1" }), { sessionId: "sess-1" });
    page.cdp.emit("Fetch.requestPaused", paused("https://example.test/boom", { requestId: "b2" }), { sessionId: "sess-1" });
    await flush();
  } finally {
    console.warn = original;
  }

  const cont = callsOf(page, "Fetch.continueRequest").map(call => call.params.requestId);
  assert.deepEqual(cont.sort(), ["b1", "b2", "s1", "s2"]);
  assert.equal(warnings.length, 2);

  await routes.dispose();
});

test("unroute removes a match and disables Fetch when no routes remain", async () => {
  const page = fakePage();
  const routes = createRoutes(page);
  await routes.route("*.png", route => route.abort());
  await routes.route("/keep", route => route.continue());
  assert.equal(routes.enabled, true);

  await routes.unroute("*.png");
  page.cdp.emit("Fetch.requestPaused", paused("https://x.test/a.png", { requestId: "png" }), { sessionId: "sess-1" });
  await flush();
  assert.equal(callsOf(page, "Fetch.failRequest").length, 0);
  assert.equal(callsOf(page, "Fetch.continueRequest").some(call => call.params.requestId === "png"), true);

  await routes.unroute("/keep");
  assert.equal(routes.enabled, false);
  assert.equal(callsOf(page, "Fetch.disable").length, 1);

  await routes.route("*", route => route.abort());
  assert.equal(routes.enabled, true);
  await routes.unroute();
  assert.equal(routes.enabled, false);
  assert.equal(callsOf(page, "Fetch.disable").length, 2);

  await routes.dispose();
});

test("page routing is lazy, shares its controller, and recovers from a refused enable", async () => {
  const page = fakePage();
  const routes = createRoutes(page);
  assert.equal(createRoutes(page), routes);
  assert.equal(page.cdp.calls.length, 0);
  const send = page.cdp.send.bind(page.cdp);
  page.cdp.send = async (method, ...args) => {
    if (method === "Fetch.enable") throw new Error("Fetch refused");
    return send(method, ...args);
  };
  await assert.rejects(OmOPage.prototype.route.call(page, "**/refused", route => route.abort()), /Fetch refused/);
  assert.equal(routes.enabled, false);
  page.cdp.send = send;
  await OmOPage.prototype.route.call(page, "**/kept", route => route.abort());
  const continued = new Promise(resolve => {
    page.cdp.send = async (method, ...args) => {
      const result = await send(method, ...args);
      if (method === "Fetch.continueRequest") resolve(args[0]);
      return result;
    };
  });
  page.cdp.emit("Fetch.requestPaused", paused("https://example.test/refused"), { sessionId: "sess-1" });
  assert.equal((await continued).requestId, "req-1");
  await OmOPage.prototype.unrouteAll.call(page);
  assert.equal(routes.enabled, false);
  assert.equal(callsOf(page, "Fetch.enable").length, 1);
  assert.equal(callsOf(page, "Fetch.disable").length, 1);
});

test("times reserves concurrent matches once and disables after settlement", async () => {
  const page = fakePage();
  const routes = createRoutes(page);
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  let hits = 0;
  await OmOPage.prototype.route.call(page, "**/*", async route => {
    hits += 1;
    await ready;
    await route.fulfill({ body: "once" });
  }, { times: 1 });
  const send = page.cdp.send.bind(page.cdp);
  let disabled;
  const done = new Promise(resolve => { disabled = resolve; });
  page.cdp.send = async (method, ...args) => {
    const result = await send(method, ...args);
    if (method === "Fetch.disable") disabled();
    return result;
  };
  page.cdp.emit("Fetch.requestPaused", paused("https://example.test/one", { requestId: "one" }), { sessionId: "sess-1" });
  page.cdp.emit("Fetch.requestPaused", paused("https://example.test/two", { requestId: "two" }), { sessionId: "sess-1" });
  assert.equal(hits, 1);
  release();
  await done;
  await routes.unroute();
  assert.equal(callsOf(page, "Fetch.fulfillRequest").length, 1);
  assert.equal(callsOf(page, "Fetch.continueRequest").length, 1);
  assert.equal(routes.enabled, false);
});
