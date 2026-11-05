import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTrace } from "../src/trace.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

class FakeCdp {
  constructor() {
    this.listeners = new Map();
    this.bodies = new Map();
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
  async send(method, params) {
    if (method === "Network.getResponseBody") return this.bodies.get(params.requestId) ?? { body: "", base64Encoded: false };
    return {};
  }
}

class FakePage {
  constructor(cdp) {
    this.cdp = cdp;
    this.listeners = new Map();
    this.consoleEntries = [];
    this.screenshotCalls = [];
    this.screenshotError = null;
  }
  async resolveSessionId() {
    return "s1";
  }
  on(name, listener) {
    const set = this.listeners.get(name) ?? new Set();
    set.add(listener);
    this.listeners.set(name, set);
    return () => set.delete(listener);
  }
  emit(name, payload) {
    for (const listener of [...this.listeners.get(name) ?? []]) listener(payload);
  }
  console() {
    return this.consoleEntries;
  }
  async screenshot(options) {
    this.screenshotCalls.push(options);
    if (this.screenshotError) throw Error(this.screenshotError);
    return PIXEL_PNG;
  }
  url() {
    return "https://x.test/app";
  }
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "omowright-trace-unit-"));
  const cdp = new FakeCdp();
  const page = new FakePage(cdp);
  return { dir, cdp, page, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function roundTrip(cdp, requestId, options = {}) {
  const { url = "https://x.test/api/items?page=2", mimeType = "application/json", meta } = options;
  cdp.emit("Network.requestWillBeSent", {
    requestId,
    request: { url, method: "GET", headers: { accept: "*/*" } },
    type: "XHR",
    wallTime: 1_700_000_000,
  }, meta);
  cdp.emit("Network.responseReceived", {
    requestId,
    type: "XHR",
    response: { status: 200, statusText: "OK", mimeType, headers: { "content-type": mimeType } },
  }, meta);
  cdp.emit("Network.loadingFinished", { requestId, encodedDataLength: 11 }, meta);
  await flush();
}

function readLines(dir) {
  return readFileSync(path.join(dir, "trace.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
}

test("a trace run writes jsonl, har, screenshots and a summary", async () => {
  const { dir, cdp, page, cleanup } = setup();
  try {
    const trace = createTrace(page, { dir });
    assert.equal(trace.dir, dir);
    await flush();

    page.emit("dialog", { type: () => "confirm", message: () => "sure?", defaultValue: () => "", url: "https://x.test/app" });
    cdp.emit("Page.frameNavigated", { frame: { id: "F1", url: "https://x.test/app" } });
    cdp.emit("Page.frameNavigated", { frame: { id: "F2", parentId: "F1", url: "https://x.test/iframe" } });
    cdp.emit("Page.frameNavigated", { frame: { id: "F3", url: "https://other.test/" } }, { sessionId: "other" });
    cdp.bodies.set("r1", { body: '{"ok":true}', base64Encoded: false });
    page.consoleEntries = [{ level: "log", message: "hello", timestamp: "2024-01-01T00:00:00.000Z" }];

    await roundTrip(cdp, "r1");
    let ran = false;
    const stepResult = await trace.step("Click Sign In", async () => {
      ran = true;
      return "done";
    });
    assert.equal(stepResult, "done");
    assert.equal(ran, true);
    trace.mark("checkpoint", { n: 1 });

    const summary = await trace.stop();
    const lines = readLines(dir);
    assert.deepEqual(lines.map(line => line.seq), lines.map((_line, index) => index));
    for (const line of lines) assert.equal(typeof line.ts, "number");

    const kinds = lines.map(line => line.kind);
    for (const kind of ["step", "network", "dialog", "navigation", "console", "mark"]) {
      assert.ok(kinds.includes(kind), `trace.jsonl is missing a ${kind} event: ${kinds.join(",")}`);
    }
    assert.equal(kinds.filter(kind => kind === "navigation").length, 1, "child frames and other sessions are ignored");

    const step = lines.find(line => line.kind === "step");
    assert.equal(step.name, "Click Sign In");
    assert.equal(typeof step.startedAt, "number");
    assert.ok(step.endedAt >= step.startedAt);
    assert.equal(step.durationMs, step.endedAt - step.startedAt);
    assert.equal(step.error, undefined);

    const dialog = lines.find(line => line.kind === "dialog");
    assert.deepEqual(
      { type: dialog.type, message: dialog.message, defaultPrompt: dialog.defaultPrompt, url: dialog.url },
      { type: "confirm", message: "sure?", defaultPrompt: "", url: "https://x.test/app" },
    );
    assert.equal(lines.find(line => line.kind === "navigation").url, "https://x.test/app");
    assert.equal(lines.find(line => line.kind === "navigation").frameId, "F1");
    assert.equal(lines.find(line => line.kind === "console").message, "hello");
    assert.deepEqual(lines.find(line => line.kind === "mark").data, { n: 1 });

    const network = lines.find(line => line.kind === "network");
    assert.equal(network.url, "https://x.test/api/items?page=2");
    assert.equal(network.body, '{"ok":true}');

    const shots = readdirSync(path.join(dir, "screenshots")).sort();
    assert.deepEqual(shots, [`${step.seq}-click-sign-in-after.png`, `${step.seq}-click-sign-in-before.png`].sort());
    for (const shot of shots) {
      assert.deepEqual(readFileSync(path.join(dir, "screenshots", shot)).subarray(0, 8), PNG_MAGIC);
    }
    assert.deepEqual(page.screenshotCalls.map(call => call.type), ["png", "png"]);

    const har = JSON.parse(readFileSync(path.join(dir, "trace.har"), "utf8"));
    assert.equal(har.log.version, "1.2");
    assert.equal(har.log.entries.length, 1);
    assert.equal(har.log.entries[0].request.url, "https://x.test/api/items?page=2");
    assert.deepEqual(JSON.parse(har.log.entries[0].response.content.text), { ok: true });

    assert.deepEqual(summary, JSON.parse(readFileSync(path.join(dir, "summary.json"), "utf8")));
    assert.equal(summary.steps, 1);
    assert.equal(summary.network, 1);
    assert.equal(summary.events, lines.length);
    assert.equal(summary.url, "https://x.test/app");
    assert.ok(summary.endedAt >= summary.startedAt);
  } finally {
    cleanup();
  }
});

test("a throwing step is recorded with its error and rethrown", async () => {
  const { dir, page, cleanup } = setup();
  try {
    const trace = createTrace(page, { dir, network: false, console: false });
    await flush();
    await assert.rejects(
      trace.step("boom", async () => {
        throw Error("step exploded");
      }),
      /step exploded/,
    );
    await trace.stop();

    const step = readLines(dir).find(line => line.kind === "step");
    assert.equal(step.name, "boom");
    assert.equal(step.error, "step exploded");
    assert.equal(typeof step.durationMs, "number");
    assert.equal(readdirSync(path.join(dir, "screenshots")).length, 2, "the after screenshot is still taken");
  } finally {
    cleanup();
  }
});

test("screenshot failures become warnings and never break the step", async () => {
  const { dir, page, cleanup } = setup();
  try {
    page.screenshotError = "capture timed out";
    const trace = createTrace(page, { dir, network: false, console: false });
    await flush();
    assert.equal(await trace.step("shot", async () => 42), 42);
    await trace.stop();

    const warnings = readLines(dir).filter(line => line.kind === "warning");
    assert.equal(warnings.length, 2);
    assert.ok(warnings[0].message.includes("capture timed out"), warnings[0].message);
    assert.equal(readdirSync(path.join(dir, "screenshots")).length, 0);
  } finally {
    cleanup();
  }
});

test("screenshots:false skips capture and stop() is idempotent", async () => {
  const { dir, cdp, page, cleanup } = setup();
  try {
    const trace = createTrace(page, { dir, screenshots: false });
    await flush();
    await trace.step("no shots", async () => {});
    assert.deepEqual(page.screenshotCalls, []);
    assert.equal(readdirSync(path.join(dir, "screenshots")).length, 0);

    const first = await trace.stop();
    assert.ok(existsSync(path.join(dir, "trace.jsonl")));
    writeFileSync(path.join(dir, "trace.jsonl"), "SENTINEL\n");
    const second = await trace.stop();
    assert.deepEqual(second, first, "stop() returns the same summary");
    assert.equal(readFileSync(path.join(dir, "trace.jsonl"), "utf8"), "SENTINEL\n", "stop() writes once");
    assert.equal(cdp.listenerCount(), 0, "stop() disposes every cdp subscription");
    assert.equal(page.listeners.get("dialog").size, 0, "stop() disposes the dialog subscription");
  } finally {
    cleanup();
  }
});
