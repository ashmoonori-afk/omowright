import { test } from "node:test";
import assert from "node:assert/strict";
import { BskSession } from "../src/bsk/session.js";
import { bskSnapshot } from "../src/bsk/snapshot.js";
import { BskRpcError } from "../src/bsk/ipc-client.js";
import { lastCall, stubClient } from "./fixtures/bsk-stub-client.mjs";

// Protocol contract (BrowserSkill 0.4 shared-tab control): the extension refuses every page
// action with permission_denied / cooperation_sync_required unless the request carries the
// context_id of the latest tool.cooperate sync, and the daemon forwards only what the caller sends.
// This stub models that refusal, so the test fails on a session that cannot send the context.
// BrowserSkill ext-v0.4.0 controller: reads bypass cooperation unless probe_hover is set.
// https://github.com/Tencent/BrowserSkill/blob/7e300ff6a35b326ac9abd03f315f30769ad01861/apps/extension/src/cooperation/controller.ts#L87-L98
const READS = new Set(["snapshot", "observe", "get_html", "screenshot", "console", "network", "extract", "wait_for_element", "wait_for_navigation", "record_start"]);
const GATED = new Set(["navigate", "navigate_back", "navigate_forward", "reload", "observe", "click", "hover", "focus", "blur", "fill", "press", "select", "scroll_to", "wheel", "evaluate", "screenshot_full_page", "tab_close", "window_resize", "emulate"]);

function sharedTabClient(replies = {}) {
  let latest = null;
  let syncs = 0;
  return stubClient(new Proxy(replies, {
    get(target, method) {
      const name = method.replace(/^tool\./, "");
      if (name === "cooperate") return (params) => {
        if (params.action !== "sync") return {};
        syncs += 1;
        latest = `ctx-${syncs}`;
        return { context_id: latest, tab_id: 7, kind: "baseline" };
      };
      if (READS.has(name) && name !== "observe") return target[method];
      if (!GATED.has(name) && name !== "observe") return target[method];
      return (params, n) => {
        if ((name !== "observe" || params.probe_hover) && (params.context_id === undefined || params.context_id !== latest)) {
          throw new BskRpcError("permission_denied", "This action requires the context returned by the latest cooperate sync", { reason: "cooperation_sync_required" });
        }
        const reply = target[method];
        return typeof reply === "function" ? reply(params, n) : reply ?? {};
      };
    },
  }));
}

const refusedForSync = (error) => error instanceof BskRpcError && error.code === "permission_denied" && error.data?.reason === "cooperation_sync_required";

test("a cooperate sync's context and dependencies reach every action the extension gates", async () => {
  const client = sharedTabClient({
    "tool.evaluate": { ok: true, value: { tree: "", refs: {}, css: {} } },
    "tool.screenshot_full_page": { capture_id: "cap-full", width: 1, height: 1, format: "png", byte_size: 0 },
    "tool.screenshot_read": { data_base64: "", next_offset: 0, eof: true },
  });
  const session = new BskSession(client, { sessionId: "abcd" });

  // Before a sync, a gated action is refused, which is all a 0.3-era caller could ever get.
  await assert.rejects(session.evaluate("document.title", { returnByValue: true }), refusedForSync);

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

  // A newer sync supersedes the old context: reusing it is refused, the new one is accepted.
  const next = await session.cooperate("sync");
  await assert.rejects(session.click("@e3", { context: synced.context_id }), refusedForSync);
  await session.click("@e3", { context: next.context_id });
  assert.deepEqual(lastCall(client).params, { session_id: "abcd", ref: "@e3", context_id: "ctx-2" });
});

// API contract: a misspelt shared-tab option must not silently send an action with no context.
test("a gated action throws on an option it does not know instead of dropping it", async () => {
  const client = stubClient();
  const session = new BskSession(client, { sessionId: "abcd" });
  assert.throws(() => session.click("@e3", { contextId: "ctx-1" }), { name: "TypeError", message: /unknown option "contextId"/ });
  assert.throws(() => session.tabClose(7, { context: "ctx-1", depends: ["@e2"] }), { name: "TypeError", message: /unknown option "depends"/ });
  assert.equal(client.calls.length, 0);
});

// Protocol contract: skills/omowright/references/browserskill.md promises these reads need no
// cooperate sync, so each must reach only BrowserSkill read tools and send no context_id.
test("documented reads need no cooperation context", async () => {
  const names = ["snapshot", "getHtml", "screenshot"];
  const client = sharedTabClient({ "tool.screenshot": { image_base64: "", width: 1, height: 1 } });
  const session = new BskSession(client, { sessionId: "abcd" });
  for (const name of names) {
    assert.equal(typeof session[name], "function", `unknown documented read: ${name}`);
    const before = client.calls.length;
    await session[name]();
    const calls = client.calls.slice(before);
    assert.ok(calls.length > 0, `${name} made no tool call`);
    for (const call of calls) {
      assert.ok(READS.has(call.method.replace(/^tool\./, "")), `${name} calls gated ${call.method}`);
      assert.equal(Object.hasOwn(call.params, "context_id"), false, name);
    }
  }
});
