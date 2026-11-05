import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, globSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { connectPipe, createAgentTabs, WaitForFunctionTimeoutError } from "../src/index.js";
import { removeTreeSync } from "./fixtures/remove-tree.mjs";

// Contract (public API, #125): page.waitForFunction(pageFunction, arg?, { timeout, polling }) resolves with the
// first truthy value the function returns in the page's main world ("raf" or millisecond polling), keeps waiting
// across a same-tab navigation and past the transport's per-command timeout, rejects when the page closes, and
// rejects on timeout with a named error that carries the function source.

function findHeadlessShell() {
  const home = process.env.HOME;
  const candidates = globSync(
    path.join(home, "Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
  );
  if (candidates.length > 0) return candidates.sort().at(-1);
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(chrome)) return chrome;
  return null;
}

const SHELL = process.env.SHELL_BIN ?? findHeadlessShell();
const LIVE = { skip: !SHELL && "no chromium binary found", timeout: 60000 };

const TEXT = "<p>A local page for the waitForFunction test, with enough text for the content readiness probe.</p>";
// The page flips its own state on a timer. The first poll arms the timer, so every run sees the old state
// first and the wait has to keep polling until the page changes; the test itself never sleeps.
const cartPage = flipAfterMs => `<!doctype html><title>cart</title><main><h1>Cart</h1>${TEXT}<span id="badge">0</span></main>
<script>window.polls = 0; window.armCart = () => { window.polls += 1; window.cartTimer ??= setTimeout(() => {
  document.getElementById("badge").textContent = "3"; window.cart = { items: 3 }; }, ${flipAfterMs}); };</script>`;
const CART = cartPage(200);
const SLOW_COMMAND_TIMEOUT_MS = 3_000;
const PAGES = {
  "/timer": CART,
  // Flips only after the transport's per-command timeout has passed (see the long-wait test).
  "/slow": cartPage(SLOW_COMMAND_TIMEOUT_MS + 1_000),
  // A background tab of a headful browser gets no animation frames; headless keeps every tab visible,
  // so this page takes the frames away itself.
  "/no-frames": `${CART}<script>window.requestAnimationFrame = () => 0;</script>`,
  "/first": `<!doctype html><title>first</title><main><h1>First</h1>${TEXT}</main>`,
  "/second": `<!doctype html><title>second</title><main><h1>Second</h1>${TEXT}</main>
<script>setTimeout(() => { window.state = "ready"; }, 100);</script>`,
};

async function withPage(run, { commandTimeoutMs } = {}) {
  const server = createServer((request, response) => {
    const body = PAGES[new URL(request.url, "http://localhost").pathname];
    response.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    response.end(body ?? "not found");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-wff-"));
  const connection = await connectPipe({
    browserPath: SHELL,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
    storageRoot: ud,
    commandTimeoutMs,
  });
  try {
    const page = (await createAgentTabs(connection).create("about:blank")).page;
    await run(page, origin);
  } finally {
    await connection.close();
    await new Promise(resolve => server.close(resolve));
    removeTreeSync(ud);
  }
}

test("waitForFunction resolves with the first truthy value after a page timer flips state (raf polling); a value CDP cannot serialize resolves as true", LIVE, async () => {
  await withPage(async (page, origin) => {
    await page.goto(`${origin}/timer`);
    const value = await page.waitForFunction(() => {
      window.armCart();
      return window.cart && { badge: document.getElementById("badge").textContent, ...window.cart, polls: window.polls };
    });
    const { polls, ...state } = value;
    assert.deepEqual(state, { badge: "3", items: 3 });
    assert.ok(polls >= 2, `the first poll saw the old state, so the wait polled again (polls=${polls})`);
    // window is truthy but cyclic: returning it by value fails in CDP, and the met condition must still resolve.
    assert.equal(await page.waitForFunction(() => window.cart && window), true);
  });
});

test("waitForFunction passes arg through with millisecond polling", LIVE, async () => {
  await withPage(async (page, origin) => {
    await page.goto(`${origin}/timer`);
    const value = await page.waitForFunction(
      ({ selector, want }) => {
        window.armCart();
        return document.querySelector(selector).textContent === want && { text: `badge=${want}`, polls: window.polls };
      },
      { selector: "#badge", want: "3" },
      { polling: 25, timeout: 10_000 },
    );
    assert.equal(value.text, "badge=3");
    assert.ok(value.polls >= 2, `the first poll saw the old state, so the wait polled again (polls=${value.polls})`);
  });
});

test("waitForFunction keeps waiting across a same-tab navigation and resolves in the new document", LIVE, async () => {
  await withPage(async (page, origin) => {
    await page.goto(`${origin}/first`);
    // The predicate itself starts the navigation while the wait is in flight on /first, so the first
    // document's execution context is destroyed mid-wait every run; the result must come from /second.
    const value = await page.waitForFunction(() => {
      if (location.pathname === "/first") {
        sessionStorage.setItem("polledFirst", "yes");
        location.href = "/second";
        return false;
      }
      return window.state === "ready" && { path: location.pathname, polledFirst: sessionStorage.getItem("polledFirst") };
    }, undefined, { timeout: 10_000 });
    assert.deepEqual(value, { path: "/second", polledFirst: "yes" });
  });
});

test("waitForFunction rejects on timeout with a named error carrying the truncated function source", LIVE, async () => {
  await withPage(async (page, origin) => {
    await page.goto(`${origin}/first`);
    const marker = "never-true-".repeat(40);
    const started = Date.now();
    const error = await page.waitForFunction(new Function(`return window.flag === "${marker}";`), undefined, { timeout: 400 })
      .then(() => null, rejection => rejection);
    assert.ok(error instanceof WaitForFunctionTimeoutError, `expected WaitForFunctionTimeoutError, got ${error}`);
    assert.equal(error.name, "WaitForFunctionTimeoutError");
    assert.equal(error.timeoutMs, 400);
    assert.match(error.message, /400ms/);
    assert.ok(error.message.includes('return window.flag === "never-true-never-true-'), error.message);
    assert.ok(!error.message.includes(marker), "the function source is truncated");
    assert.ok(error.message.endsWith("…"), error.message);
    assert.ok(Date.now() - started < 5_000, "rejects near the timeout, not after a default wait");
  });
});

test("waitForFunction raf polling still re-polls a page that gets no animation frames", LIVE, async () => {
  await withPage(async (page, origin) => {
    await page.goto(`${origin}/no-frames`);
    const value = await page.waitForFunction(() => {
      window.armCart();
      return window.cart && { items: window.cart.items, polls: window.polls };
    }, undefined, { timeout: 10_000 });
    assert.equal(value.items, 3);
    assert.ok(value.polls >= 2, `the wait polled again without a frame (polls=${value.polls})`);
  });
});

test("waitForFunction rejects when the page closes during the wait, even with no timeout", LIVE, async () => {
  await withPage(async (page, origin) => {
    await page.goto(`${origin}/first`);
    const rejected = assert.rejects(
      page.waitForFunction(() => { window.polling = true; return false; }, undefined, { timeout: 0 }),
      /page closed while waiting/,
    );
    // A second wait returns once the first one's page loop runs, so its evaluation is in flight at close.
    await page.waitForFunction(() => window.polling === true);
    await page.close();
    await rejected;
  }, {
    // Closing a target while an evaluation is pending can leave page.close()'s own cleanup waiting out the
    // command timeout (a pending page.evaluate does the same on main); a short one keeps this test fast.
    commandTimeoutMs: 5_000,
  });
});

test("waitForFunction outlives the transport's per-command timeout", LIVE, async () => {
  await withPage(async (page, origin) => {
    await page.goto(`${origin}/slow`);
    // The page flips one second after the command timeout, so one page loop call has to run past it.
    const value = await page.waitForFunction(() => {
      window.armCart();
      return window.cart && window.cart.items;
    }, undefined, { timeout: 15_000 });
    assert.equal(value, 3);
  }, { commandTimeoutMs: SLOW_COMMAND_TIMEOUT_MS });
});
