import { test } from "node:test";
import assert from "node:assert/strict";
import { BskSession } from "../src/bsk/session.js";
import { connectBrowserSkill } from "../src/bsk/connect.js";
import { bskSnapshot } from "../src/bsk/snapshot.js";
import { resolveTarget } from "../src/bsk/targets.js";

function stubClient(replies = {}) {
  const calls = [];
  return {
    calls,
    async call(method, params, options) {
      calls.push({ method, params, options });
      const reply = replies[method];
      if (typeof reply === "function") return reply(params, calls.length);
      if (reply instanceof Error) throw reply;
      return reply ?? {};
    },
  };
}

function lastCall(client) { return client.calls.at(-1); }

test("resolveTarget maps refs, selectors and capture coordinates to daemon fields", () => {
  assert.deepEqual(resolveTarget("@e3"), { ref: "@e3" });
  assert.deepEqual(resolveTarget("e12"), { ref: "e12" });
  assert.deepEqual(resolveTarget("#login > button"), { selector: "#login > button" });
  assert.deepEqual(resolveTarget({ selector: "input[name=q]" }), { selector: "input[name=q]" });
  assert.deepEqual(resolveTarget({ ref: "e2" }), { ref: "e2" });
  assert.deepEqual(resolveTarget({ captureId: "cap-1", x: 10.5, y: 20 }), { capture_id: "cap-1", image_x: 10.5, image_y: 20 });
  assert.throws(() => resolveTarget(42), /target/);
});

test("every session method sends the daemon's tool method with session_id injected and snake_case params", async () => {
  const client = stubClient({ "tool.navigate": { tab_id: 7, url: "https://example.com", reached: "load" } });
  const session = new BskSession(client, { sessionId: "abcd", browserInstanceId: "inst-1" });

  await session.navigate("https://example.com", { waitUntil: "networkidle", timeoutMs: 5000 });
  assert.deepEqual(lastCall(client), { method: "tool.navigate", params: { session_id: "abcd", url: "https://example.com", wait_until: "networkidle", timeout_ms: 5000 }, options: { idPrefix: "navigate" } });

  await session.back({ waitUntil: "load" });
  assert.equal(lastCall(client).method, "tool.navigate_back");
  assert.deepEqual(lastCall(client).params, { session_id: "abcd", wait_until: "load" });
  await session.forward();
  assert.equal(lastCall(client).method, "tool.navigate_forward");
  await session.reload({ hard: true });
  assert.deepEqual(lastCall(client).params, { session_id: "abcd", hard: true });

  await session.observe({ maxTokens: 2000, cursor: "c1", probeHover: false, tabId: 7 });
  assert.equal(lastCall(client).method, "tool.observe");
  assert.deepEqual(lastCall(client).params, { session_id: "abcd", max_tokens: 2000, cursor: "c1", probe_hover: false, tab_id: 7 });
  await session.snapshot({ maxDepth: 12 });
  assert.deepEqual(lastCall(client), { method: "tool.snapshot", params: { session_id: "abcd", max_depth: 12 }, options: { idPrefix: "snapshot" } });
  await session.getHtml({ ref: "e4", maxBytes: 100 });
  assert.deepEqual(lastCall(client).params, { session_id: "abcd", ref: "e4", max_bytes: 100 });

  await session.click("@e3", { button: "right", clickCount: 2, modifiers: ["shift"] });
  assert.deepEqual(lastCall(client), { method: "tool.click", params: { session_id: "abcd", ref: "@e3", button: "right", click_count: 2, modifiers: ["shift"] }, options: { idPrefix: "click" } });
  await session.click({ captureId: "cap-9", x: 1, y: 2 });
  assert.deepEqual(lastCall(client).params, { session_id: "abcd", capture_id: "cap-9", image_x: 1, image_y: 2 });
  await session.hover("e5", { settleMs: 300 });
  assert.deepEqual(lastCall(client).params, { session_id: "abcd", ref: "e5", settle_ms: 300 });
  await session.fill("input[name=q]", "hello", { clearBefore: false });
  assert.deepEqual(lastCall(client), { method: "tool.fill", params: { session_id: "abcd", selector: "input[name=q]", value: "hello", clear_before: false }, options: { idPrefix: "fill" } });
  await session.press("Enter", { target: "e5", holdMs: 10, modifiers: ["ctrl"] });
  assert.deepEqual(lastCall(client).params, { session_id: "abcd", key: "Enter", ref: "e5", hold_ms: 10, modifiers: ["ctrl"] });
  await session.press("Escape");
  assert.deepEqual(lastCall(client).params, { session_id: "abcd", key: "Escape" });
  await session.select("e6", ["a", "b"]);
  assert.deepEqual(lastCall(client).params, { session_id: "abcd", ref: "e6", values: ["a", "b"] });
  await session.select("e6", "only");
  assert.deepEqual(lastCall(client).params.values, ["only"]);
  await session.focus("e7");
  assert.equal(lastCall(client).method, "tool.focus");
  await session.blur("e7");
  assert.equal(lastCall(client).method, "tool.blur");
  await session.scrollTo("e8", { timeoutMs: 100 });
  assert.deepEqual(lastCall(client), { method: "tool.scroll_to", params: { session_id: "abcd", ref: "e8", timeout_ms: 100 }, options: { idPrefix: "scroll-to" } });
  await session.wheel({ deltaY: 600 });
  assert.deepEqual(lastCall(client).params, { session_id: "abcd", delta_x: 0, delta_y: 600 });
  await session.wheel({ deltaX: -5, deltaY: 0, target: "e1" });
  assert.deepEqual(lastCall(client).params, { session_id: "abcd", ref: "e1", delta_x: -5, delta_y: 0 });

  await session.evaluate("1+1", { awaitPromise: false, timeoutMs: 100 });
  assert.deepEqual(lastCall(client), { method: "tool.evaluate", params: { session_id: "abcd", expression: "1+1", await_promise: false, timeout_ms: 100 }, options: { idPrefix: "evaluate" } });

  await session.tabList({ scope: "user" });
  assert.deepEqual(lastCall(client).params, { session_id: "abcd", scope: "user" });
  await session.tabCreate({ url: "about:blank", active: false });
  assert.deepEqual(lastCall(client).params, { session_id: "abcd", url: "about:blank", active: false });
  await session.tabClose(9);
  assert.deepEqual(lastCall(client), { method: "tool.tab_close", params: { session_id: "abcd", tab_id: 9 }, options: { idPrefix: "tab-close" } });
  await session.tabSelect(9);
  assert.equal(lastCall(client).method, "tool.tab_select");
  await session.tabBorrow(11, { confirmationTimeoutMs: 1000 });
  assert.deepEqual(lastCall(client).params, { session_id: "abcd", tab_id: 11, confirmation_timeout_ms: 1000 });
  await session.tabReturn(11);
  assert.deepEqual(lastCall(client), { method: "tool.tab_return", params: { session_id: "abcd", tab_id: 11 }, options: { idPrefix: "tab-return" } });

  await session.waitForNavigation({ waitUntil: "commit" });
  assert.deepEqual(lastCall(client).params, { session_id: "abcd", wait_until: "commit" });
  await session.requestHelp({ prompt: "Solve the captcha", targets: ["e2"], timeoutMs: 60000 });
  assert.deepEqual(lastCall(client).params, { session_id: "abcd", prompt: "Solve the captcha", targets: [{ ref: "e2" }], timeout_ms: 60000 });
  await session.console({ since: 5, limit: 10, includeStack: true });
  assert.deepEqual(lastCall(client).params, { session_id: "abcd", since: 5, limit: 10, include_stack: true });
  await session.network({ since: 3 });
  assert.deepEqual(lastCall(client), { method: "tool.network", params: { session_id: "abcd", since: 3 }, options: { idPrefix: "network" } });
  await session.resize(1280, 800);
  assert.deepEqual(lastCall(client).params, { session_id: "abcd", width: 1280, height: 800 });
  await session.emulate({ overrides: { width: 390, mobile: true } });
  assert.deepEqual(lastCall(client).params, { session_id: "abcd", overrides: { width: 390, mobile: true } });
  await session.emulate({ off: true });
  assert.deepEqual(lastCall(client).params, { session_id: "abcd", off: true });

  await session.stop();
  assert.deepEqual(lastCall(client), { method: "session.stop", params: { session_id: "abcd" }, options: { idPrefix: "session-stop", timeoutMs: 3_600_000 } });
  assert.equal(session.stopped, true);
  await assert.rejects(session.navigate("https://x"), /stopped/);
});

test("undefined options never leak into params", async () => {
  const client = stubClient();
  const session = new BskSession(client, { sessionId: "abcd" });
  await session.click("e1", { button: undefined, timeoutMs: undefined });
  assert.deepEqual(lastCall(client).params, { session_id: "abcd", ref: "e1" });
});

// Protocol contract (BrowserSkill 0.4 shared-tab control): the extension refuses every page
// action with cooperation_sync_required unless the request carries the context_id the latest
// tool.cooperate sync returned, and the daemon forwards only what the caller sends.
test("a cooperate sync's context and dependencies reach every action the extension gates", async () => {
  const client = stubClient({
    "tool.cooperate": { context_id: "ctx-1", tab_id: 7, kind: "baseline" },
    "tool.evaluate": { ok: true, value: { tree: "", refs: {}, css: {} } },
    "tool.screenshot_full_page": { capture_id: "cap-full", width: 1, height: 1, format: "png", byte_size: 0 },
    "tool.screenshot_read": { data_base64: "", next_offset: 0, eof: true },
  });
  const session = new BskSession(client, { sessionId: "abcd" });

  const synced = await session.cooperate("sync", { maxTokens: 100 });
  assert.deepEqual(lastCall(client), { method: "tool.cooperate", params: { session_id: "abcd", action: "sync", max_tokens: 100 }, options: { idPrefix: "cooperate" } });
  await session.cooperate("wait", { timeoutMs: 25_000, tabId: 7 });
  assert.deepEqual(lastCall(client).params, { session_id: "abcd", action: "wait", tab_id: 7, timeout_ms: 25_000 });

  const shared = { context: synced.context_id, dependsOn: ["@e2"] };
  const bound = { context_id: "ctx-1", depends_on: ["@e2"] };
  const actions = [
    ["tool.navigate", () => session.navigate("https://example.com", shared)],
    ["tool.navigate_back", () => session.back(shared)],
    ["tool.navigate_forward", () => session.forward(shared)],
    ["tool.reload", () => session.reload(shared)],
    ["tool.observe", () => session.observe({ probeHover: true, ...shared })],
    ["tool.click", () => session.click("@e3", shared)],
    ["tool.hover", () => session.hover("@e3", shared)],
    ["tool.focus", () => session.focus("@e3", shared)],
    ["tool.blur", () => session.blur("@e3", shared)],
    ["tool.fill", () => session.fill("@e3", "x", shared)],
    ["tool.press", () => session.press("Enter", shared)],
    ["tool.select", () => session.select("@e3", "a", shared)],
    ["tool.scroll_to", () => session.scrollTo("@e3", shared)],
    ["tool.wheel", () => session.wheel({ deltaY: 10, ...shared })],
    ["tool.evaluate", () => session.evaluate("1", shared)],
    ["tool.evaluate", () => bskSnapshot(session, shared)],
    ["tool.screenshot_release", () => session.screenshot({ fullPage: true, ...shared })],
    ["tool.tab_close", () => session.tabClose(7, shared)],
    ["tool.window_resize", () => session.resize(800, 600, shared)],
    ["tool.emulate", () => session.emulate({ off: true, ...shared })],
  ];
  for (const [method, act] of actions) {
    await act();
    const sent = method === "tool.screenshot_release"
      ? client.calls.findLast((c) => c.method === "tool.screenshot_full_page")
      : lastCall(client);
    assert.equal(lastCall(client).method, method);
    assert.deepEqual(
      { context_id: sent.params.context_id, depends_on: sent.params.depends_on },
      bound,
      method,
    );
  }

  await session.click("@e3", { context: "ctx-2" });
  assert.deepEqual(lastCall(client).params, { session_id: "abcd", ref: "@e3", context_id: "ctx-2" });
});

test("screenshot returns the viewport PNG inline and reassembles full-page captures from chunks", async () => {
  const png = Buffer.from("png-bytes-here");
  const chunks = [png.subarray(0, 5), png.subarray(5, 9), png.subarray(9)];
  let released = null;
  const client = stubClient({
    "tool.screenshot": { capture_id: "cap-1", image_base64: png.toString("base64"), width: 10, height: 20, format: "png", tab_id: 7, dialogs: [] },
    "tool.screenshot_full_page": { capture_id: "cap-full", width: 10, height: 300, format: "png", tab_id: 7, byte_size: png.length, dialogs: [] },
    "tool.screenshot_read": (params) => {
      const starts = [0, 5, 9];
      const chunk = chunks[starts.indexOf(params.offset)];
      assert.ok(chunk, `unexpected read offset ${params.offset}`);
      const next = params.offset + chunk.length;
      return { data_base64: chunk.toString("base64"), next_offset: next, eof: next >= png.length };
    },
    "tool.screenshot_release": (params) => { released = params.capture_id; return { released: true }; },
  });
  const session = new BskSession(client, { sessionId: "abcd" });

  const shot = await session.screenshot({ ref: "e1" });
  assert.deepEqual(client.calls[0].params, { session_id: "abcd", ref: "e1" });
  assert.equal(Buffer.compare(shot.buffer, png), 0);
  assert.deepEqual({ width: shot.width, height: shot.height, format: shot.format, captureId: shot.captureId, tabId: shot.tabId }, { width: 10, height: 20, format: "png", captureId: "cap-1", tabId: 7 });

  const full = await session.screenshot({ fullPage: true, scope: "current", timeoutMs: 9000 });
  const fullCall = client.calls.find((c) => c.method === "tool.screenshot_full_page");
  assert.deepEqual(fullCall.params, { session_id: "abcd", scope: "current", timeout_ms: 9000 });
  const reads = client.calls.filter((c) => c.method === "tool.screenshot_read").map((c) => c.params);
  assert.deepEqual(reads, [
    { session_id: "abcd", capture_id: "cap-full", offset: 0 },
    { session_id: "abcd", capture_id: "cap-full", offset: 5 },
    { session_id: "abcd", capture_id: "cap-full", offset: 9 },
  ]);
  assert.equal(Buffer.compare(full.buffer, png), 0);
  assert.equal(full.height, 300);
  assert.equal(released, "cap-full");
});

test("connectBrowserSkill starts a session on the daemon and hands back a live BskSession", async () => {
  const client = stubClient({
    "system.status": { browsers: [{ instance_id: "inst-1" }], daemon_version: "0.3.0", protocol_version: "1.3" },
    "session.start": { session_id: "wxyz", browser_instance_id: "inst-1", agent_window_id: 42 },
  });
  const session = await connectBrowserSkill({ client, name: "smoke", browser: "inst-1", width: 1200, height: 800 });
  const start = client.calls.find((c) => c.method === "session.start");
  assert.deepEqual(start.params, { task_name: "smoke", browser_instance_id: "inst-1", width: 1200, height: 800, focused: false });
  assert.equal(session.sessionId, "wxyz");
  assert.equal(session.browserInstanceId, "inst-1");
  assert.equal(session.agentWindowId, 42);
  const status = client.calls.find((c) => c.method === "system.status");
  assert.deepEqual(status.params, { wait_for_browser_ms: 15_000 });
});

test("connectBrowserSkill refuses to continue when no browser is attached instead of falling back", async () => {
  const client = stubClient({ "system.status": { browsers: [], daemon_version: "0.3.0", protocol_version: "1.3" } });
  await assert.rejects(connectBrowserSkill({ client, waitForBrowserMs: 10 }), (err) => {
    assert.equal(err.code, "no_browser_connected");
    assert.match(err.message, /extension/i);
    return true;
  });
  assert.equal(client.calls.some((c) => c.method === "session.start"), false);
});
