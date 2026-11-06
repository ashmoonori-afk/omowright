import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentTabs, DEFAULT_AGENT_VIEWPORT } from "../src/index.js";
import { BrowserConnection } from "../src/connection.js";

class Emitter { constructor() { this.map = new Map(); } on(n, f) { const s = this.map.get(n) ?? new Set(); s.add(f); this.map.set(n, s); return () => s.delete(f); } emit(n, p, m = {}) { for (const f of [...this.map.get(n) ?? []]) f(p, m); } }
function connection({ headless = true, send = null } = {}) {
  const calls = []; const cdp = { calls, isHeadless: headless, transportEvents: new Emitter(), on: (n, f) => cdp.events.on(n, f), events: new Emitter(), ensureConnected: async () => {}, send: send ?? (async (method, params, sessionId, options) => { calls.push({ method, params, sessionId, options }); if (method === "Target.createTarget") return { targetId: "owned" }; return {}; }) }; 
  const page = { targetId: "owned", cdp, events: new Emitter(), resolveSessionId: async () => "session", setCachedViewportSize(size) { this.viewport = size; }, on(name, fn) { return this.events.on(name, fn); }, async goto(url) { calls.push({ method: "goto", url }); }, async dispose() {} };
  return { cdp, page, attachPage: async () => { calls.push({ method: "attachPage" }); return page; } };
}
test("creates owned background tab and repins after main navigation", async () => {
  const c = connection(); const tabs = createAgentTabs(c); await tabs.ready;
  const tab = await tabs.create();
  assert.deepEqual(tab.viewport, DEFAULT_AGENT_VIEWPORT); assert.deepEqual(tabs.get("owned").viewport, tab.viewport);
  const create = c.cdp.calls.find(call => call.method === "Target.createTarget");
  assert.deepEqual(create.params, { url: "about:blank", background: true, newWindow: true }); assert.ok(create.options?.capability);
  assert.equal(c.cdp.calls.some(call => call.method === "Target.activateTarget"), true);
  c.page.events.emit("framenavigated", { frameId: "main", parentFrameId: null });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(c.cdp.calls.filter(call => call.method === "Emulation.setDeviceMetricsOverride").length, 2);
  c.page.events.emit("framenavigated", { frameId: "child", parentFrameId: "main" }); await Promise.resolve();
  assert.equal(c.cdp.calls.filter(call => call.method === "Emulation.setDeviceMetricsOverride").length, 2);
  await tabs.dispose({ closeOwned: false }); await assert.rejects(tabs.create(), /disposed/);
});

test("headed creation attaches directly without stealing focus", async () => {
  const c = connection({ headless: false }); const tabs = createAgentTabs(c); await tabs.ready; await tabs.create();
  assert.equal(c.cdp.calls.some(call => call.method === "Target.activateTarget"), false);
});

test("factory rejects close timeout conflicts and activation precedes attach", async () => {
  const c = connection(); const tabs = createAgentTabs(c, { closeTimeoutMs: 100 }); await tabs.ready; await tabs.create();
  const order = c.cdp.calls.map(call => call.method);
  assert.ok(order.indexOf("Target.activateTarget") >= 0 && order.indexOf("Target.activateTarget") < order.indexOf("attachPage"), `activation must precede attach: ${order.join(", ")}`);
  assert.throws(() => createAgentTabs(c, { closeTimeoutMs: 200 }), /Conflicting/);
});

test("close resolves once the matching target is destroyed and releases ownership", async () => {
  const c = connection(); const tabs = createAgentTabs(c); await tabs.ready; const tab = await tabs.create("https://x.test");
  const closing = tabs.close(tab, { timeoutMs: 100 });
  await Promise.resolve(); c.cdp.events.emit("Target.targetDestroyed", { targetId: "owned" }); await closing;
  assert.equal(tabs.list().length, 0);
});

test("navigation and explicit repins are serialized in request order", async () => {
  const pending = []; let pinCount = 0; let firstStarted, secondStarted; const firstStartedPromise = new Promise(resolve => { firstStarted = resolve; }); const secondStartedPromise = new Promise(resolve => { secondStarted = resolve; }); const c = connection({ send: async (method, params, sessionId, options) => {
    c.cdp.calls.push({ method, params, sessionId, options });
    if (method === "Target.createTarget") return { targetId: "owned" };
    if (method === "Emulation.setDeviceMetricsOverride" && pinCount++ > 0) { if (pinCount === 2) firstStarted(); else secondStarted(); await new Promise(resolve => pending.push(resolve)); }
    return {};
  }});
  const tabs = createAgentTabs(c); await tabs.ready; const tab = await tabs.create();
  const first = tabs.repin(tab, { width: 800, height: 600 });
  await firstStartedPromise;
  const second = tabs.repin(tab, { width: 1024, height: 768 });
  assert.equal(pending.length, 1);
  pending.shift()(); await secondStartedPromise;
  assert.equal(pending.length, 1);
  pending.shift()(); await Promise.all([first, second]);
  const sizes = c.cdp.calls.filter(call => call.method === "Emulation.setDeviceMetricsOverride").map(call => call.params);
  assert.deepEqual(sizes.slice(-2).map(({ width, height }) => ({ width, height })), [{ width: 800, height: 600 }, { width: 1024, height: 768 }]);
  assert.deepEqual(tabs.get("owned").viewport, { width: 1024, height: 768 });
});

test("close failure leaves target owned and dispose reports close failures", async () => {
  const c = connection(); const tabs = createAgentTabs(c, { closeTimeoutMs: 10 }); await tabs.ready; const tab = await tabs.create();
  await assert.rejects(tabs.close(tab), /Timed out/); assert.ok(tabs.get(tab.targetId));
  await assert.rejects(tabs.dispose(), AggregateError); assert.ok(tabs.get(tab.targetId));
});

test("BrowserConnection exposes newTab on the attach path", async () => {
  // newTab is a BrowserConnection class method, not a connectPipe instance
  // patch, so connect()-style attach clients get the launch path's tab API.
  const calls = [];
  const cdp = {
    isHeadless: true,
    transportEvents: new Emitter(),
    events: new Emitter(),
    on: (name, listener) => cdp.events.on(name, listener),
    ensureConnected: async () => {},
    discoverTargets: async () => [],
    close: async () => {},
    send: async (method, params, sessionId, options) => {
      calls.push({ method, params, sessionId, options });
      if (method === "Target.createTarget") return { targetId: "attached-tab" };
      if (method === "Target.closeTarget") cdp.events.emit("Target.targetDestroyed", { targetId: params.targetId });
      return {};
    },
  };
  const connection = new BrowserConnection(cdp);
  const page = { targetId: "attached-tab", cdp, resolveSessionId: async () => "session", setCachedViewportSize() {}, on: () => () => {}, async dispose() {} };
  connection.attachPage = async (targetId) => { calls.push({ method: "attachPage", targetId }); return page; };

  const opened = await connection.newTab();
  assert.equal(opened, page);
  const create = calls.find(call => call.method === "Target.createTarget");
  assert.deepEqual(create.params, { url: "about:blank", background: true, newWindow: true });
  assert.ok(create.options?.capability, "createTarget must carry the reserved capability");
  const order = calls.map(call => call.method);
  assert.ok(order.indexOf("Target.activateTarget") < order.indexOf("attachPage"), `activation must precede attach: ${order.join(", ")}`);
  assert.ok(order.includes("Emulation.setDeviceMetricsOverride"), "newTab must repin the viewport");
  assert.equal(createAgentTabs(connection).get("attached-tab").page, page, "newTab must register with the per-connection manager");
  await connection.close();
  assert.equal(calls.some(call => call.method === "Target.closeTarget"), false, "disconnect must leave ordinary newTab targets open");
});
