import { test } from "node:test";
import assert from "node:assert/strict";
import { compactSnapshot, snapshotTokens, toolSchemas } from "../src/llm.js";

const GITHUB_LIKE = JSON.stringify({
  tree: '- heading "Example Domain" [level=1]\n- text: "sample"\n- paragraph:\n  - link "Learn more" [ref=e1]',
  refs: { e1: { role: "link", name: "Learn more", tagName: "A", nthAmongSameSignature: 0 } },
});

test("compactSnapshot returns the raw tree from a JSON string", () => {
  const tree = compactSnapshot(GITHUB_LIKE);
  assert.equal(tree, '- heading "Example Domain" [level=1]\n- text: "sample"\n- paragraph:\n  - link "Learn more" [ref=e1]');
});

test("compactSnapshot accepts an already-parsed object", () => {
  const tree = compactSnapshot(JSON.parse(GITHUB_LIKE));
  assert.ok(tree.includes('[ref=e1]'));
  assert.ok(!tree.includes("nthAmongSameSignature"));
});

test("compactSnapshot drops the refs-map bytes", () => {
  const full = Buffer.byteLength(GITHUB_LIKE, "utf8");
  const compact = Buffer.byteLength(compactSnapshot(GITHUB_LIKE), "utf8");
  assert.ok(compact < full * 0.75, `expected >25% saving, got full=${full} compact=${compact}`);
});

test("compactSnapshot rejects malformed input", () => {
  assert.throws(() => compactSnapshot('{"nope":1}'), TypeError);
  assert.throws(() => compactSnapshot(42), TypeError);
});

test("compactSnapshot renders delta entries and frame-local removed ranges", () => {
  const snapshot = { full: false, diff: {
    added: [{ ref: "e8", tree: 'textbox "Extra" [ref=e8]' }],
    changed: [{ ref: "e1", tree: 'textbox "Name" [ref=e1]: "Ada"' }],
    removed: ["e2", "e3", "e4", "e7", "f1e2", "f1e3", "f2e1"],
    focused: "e1",
  } };
  assert.equal(compactSnapshot(snapshot), [
    '+ textbox "Extra" [ref=e8]',
    '~ textbox "Name" [ref=e1]: "Ada"',
    '- e2-e4, e7, f1e2-f1e3, f2e1',
    '@focused e1',
  ].join("\n"));
  assert.equal(compactSnapshot(JSON.stringify(snapshot)), compactSnapshot(snapshot));
});

test("snapshotTokens reports bytes and token estimate", () => {
  const { bytes, estTokens } = snapshotTokens(GITHUB_LIKE);
  assert.equal(bytes, Buffer.byteLength(GITHUB_LIKE, "utf8"));
  assert.equal(estTokens, Math.ceil(bytes / 4));
});

test("toolSchemas are complete and lean", () => {
  assert.ok(Array.isArray(toolSchemas));
  assert.ok(toolSchemas.length >= 8);
  for (const schema of toolSchemas) {
    assert.ok(schema.name && typeof schema.name === "string");
    assert.ok(schema.description && typeof schema.description === "string");
    assert.ok(schema.description.length <= 220, `${schema.name} description too long: ${schema.description.length}`);
    assert.equal(typeof schema.parameters, "object");
    assert.equal(schema.parameters.type, "object", `${schema.name} parameters.type`);
  }
  const names = toolSchemas.map(s => s.name);
  for (const required of [
    "page.snapshot", "page.locator", "page.goto", "compactSnapshot",
    "createNetworkSnoop", "snoop.waitFor", "snoop.popJson", "snoop.summary",
    "collectWhileScrolling", "createTrace", "trace.step", "trace.stop",
    "reconcileFrames", "snapshotWithFrames", "connectPipe.dialogPolicy",
    "requestHuman", "describeLayers", "snapshotWithLayers", "emulate",
    "createRoutes", "route.continue", "route.fulfill", "route.abort",
  ]) {
    assert.ok(names.includes(required), `missing schema: ${required}`);
  }
});
