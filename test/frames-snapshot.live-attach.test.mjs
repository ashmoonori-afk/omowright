import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileFrames, snapshotWithFrames } from "../src/frames-snapshot.js";
import {
  SHELL,
  childFrameOf,
  clickUntilChildObserves,
  createRawTab,
  forgetFrame,
  launch,
  listIframeTargets,
  startFixtureServers,
  waitForChildContent,
  waitForChildTarget,
  waitUntil,
} from "./fixtures/oopif-harness.mjs";

const live = { skip: !SHELL && "no chromium binary found", timeout: 60_000 };

async function waitForFreshChildDocument(page) {
  return waitUntil(async () => {
    const frame = childFrameOf(page);
    if (!frame) return null;
    const state = await page.evaluateInFrame(
      frame.frameId,
      "document.querySelector('#inside') ? (document.body.getAttribute('data-clicked') ?? 'fresh') : 'pending'",
    );
    return state === "fresh" ? frame : null;
  }, { label: "reloaded child document" });
}

test("attaching to a tab whose OOPIF already exists snapshots the child", live, async () => {
  const fixtures = await startFixtureServers();
  let launched;
  try {
    launched = await launch();
    const { connection } = launched;
    const targetId = await createRawTab(connection, fixtures.urlFor("oopif-parent.html"));
    await waitForChildTarget(connection);
    const page = await connection.attachPage(targetId);

    // FrameManager now registers its Target.attachedToTarget listener before it asks for
    // auto-attach, so the OOPIF that already existed is onboarded during initialize() and
    // there is nothing left for reconcileFrames to adopt.
    const before = await page.snapshot();
    assert.ok(before.tree.includes(`button "Inside" [ref=f1e1]`), before.tree);
    assert.equal(page.frames().length, 2);
    assert.deepEqual(await reconcileFrames(page), []);

    const snapshot = await snapshotWithFrames(page);
    assert.ok(snapshot.tree.includes(`button "Inside" [ref=f1e1]`), snapshot.tree);
    assert.equal(snapshot.refs.f1e1?.name, "Inside");
    assert.equal(snapshot.missingFrames, undefined);

    const child = childFrameOf(page);
    assert.equal(await clickUntilChildObserves(page, "f1e1", child.frameId, "data-clicked"), "1");

    // Idempotence: nothing left to adopt, and core keeps tracking the frame across reloads.
    assert.deepEqual(await reconcileFrames(page), []);
    await page.evaluateInFrame(child.frameId, "location.reload(), 1");
    await waitForFreshChildDocument(page);
    assert.deepEqual(await reconcileFrames(page), []);
    const reloaded = await snapshotWithFrames(page);
    assert.ok(reloaded.tree.includes(`button "Inside" [ref=f1e1]`), reloaded.tree);
  } finally {
    await launched?.cleanup();
    await fixtures.close();
  }
});

test("a frame lost from FrameManager is re-adopted by reconcileFrames", live, async () => {
  const fixtures = await startFixtureServers();
  let launched;
  try {
    launched = await launch();
    const { connection } = launched;
    const targetId = await createRawTab(connection, fixtures.urlFor("oopif-parent.html"));
    await waitForChildTarget(connection);
    const page = await connection.attachPage(targetId);
    const { frameId: childFrameId } = await waitForChildContent(page);

    // Simulate the frame going missing (the pre-fix attach path, a dropped event, a
    // reconnect that raced the auto-attach): the child content disappears from the tree.
    await forgetFrame(page, childFrameId);
    const lost = await page.snapshot();
    assert.ok(!lost.tree.includes("Inside"), lost.tree);

    const added = await reconcileFrames(page);
    assert.deepEqual(added.map(entry => entry.frameId), [childFrameId]);
    assert.ok(added[0].url.endsWith("/child"), added[0].url);
    assert.equal(typeof added[0].isolatedContextId, "number");

    const recovered = await snapshotWithFrames(page);
    assert.ok(recovered.tree.includes(`button "Inside" [ref=f1e1]`), recovered.tree);
    assert.equal(recovered.missingFrames, undefined);
    assert.equal(await clickUntilChildObserves(page, "f1e1", childFrameId, "data-clicked"), "1");
  } finally {
    await launched?.cleanup();
    await fixtures.close();
  }
});

test("Turnstile shape: OOPIF inside a closed shadow root is appended as an orphan block", live, async () => {
  const fixtures = await startFixtureServers();
  let launched;
  try {
    launched = await launch();
    const { connection } = launched;
    const targetId = await createRawTab(connection, fixtures.urlFor("oopif-turnstile.html"));
    await waitForChildTarget(connection);
    const page = await connection.attachPage(targetId);

    assert.deepEqual(await reconcileFrames(page), []);

    const snapshot = await snapshotWithFrames(page);
    assert.ok(snapshot.tree.includes("\n- iframe:\n"), snapshot.tree);
    assert.ok(snapshot.tree.includes(`button "Inside" [ref=f1e1]`), snapshot.tree);
    assert.ok(snapshot.tree.includes(`button "Outside"`), snapshot.tree);

    const child = childFrameOf(page);
    assert.equal(await clickUntilChildObserves(page, "f1e1", child.frameId, "data-clicked"), "1");
  } finally {
    await launched?.cleanup();
    await fixtures.close();
  }
});

test("an OOPIF that belongs to another tab is never adopted", live, async () => {
  const fixtures = await startFixtureServers();
  let launched;
  try {
    launched = await launch();
    const { connection } = launched;
    await createRawTab(connection, fixtures.urlFor("oopif-parent.html"));
    const foreign = await waitForChildTarget(connection, { label: "foreign child iframe target" });

    const targetId = await createRawTab(connection, fixtures.urlFor("oopif-parent.html"));
    const own = await waitUntil(
      async () => (await listIframeTargets(connection)).find(info => info.targetId !== foreign.targetId) ?? null,
      { label: "own child iframe target" },
    );
    const page = await connection.attachPage(targetId);
    await waitForChildContent(page);

    // Drop the page's own child so reconcile has to attribute both iframe targets.
    await forgetFrame(page, own.targetId);
    const added = await reconcileFrames(page);
    assert.deepEqual(added.map(entry => entry.frameId), [own.targetId]);
    assert.equal(page.frameManager.frames.has(foreign.targetId), false);
    assert.equal(page.frames().length, 2);

    // Attribution detaches again, so the foreign target keeps no session from this page.
    const foreignAfter = await waitUntil(
      async () => (await listIframeTargets(connection)).find(info => info.targetId === foreign.targetId && info.attached === false) ?? null,
      { label: "foreign iframe target detached again" },
    );
    assert.equal(foreignAfter.attached, false);

    const snapshot = await snapshotWithFrames(page);
    assert.ok(snapshot.tree.includes(`button "Inside" [ref=f1e1]`), snapshot.tree);
  } finally {
    await launched?.cleanup();
    await fixtures.close();
  }
});
