// Public locator API (#144): getByPlaceholder / getByTestId / getByTitle / getByAltText on page, frame, frame locator
// and chained on a locator, and getByLabel (#172) on page, frame and frame locator, with Playwright's matching rules. A string matches as a case-insensitive substring,
// `exact: true` as a case-sensitive whole value, a RegExp against the raw attribute value; getByTestId is always exact
// for strings and reads `data-testid` unless `selectors.setTestIdAttribute()` names another attribute. Like getByText
// (#129), the getters see elements inside open shadow roots, nested ones included, and never inside closed roots.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, globSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectPipe, createAgentTabs, selectors } from "../src/index.js";
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

// The same markup is rendered in the top document (ids prefixed "p-") and in a child frame ("f-"), so every container
// must find exactly its own copy and never the other document's. `#form` holds one match per getter for the chained
// cases; the closed shadow root holds values the open-root cases would also match if closed roots were searched.
const markup = (prefix) => `
<input id="${prefix}search-docs" placeholder="Search the docs">
<input id="${prefix}search" placeholder="Search">
<input id="${prefix}next-step" placeholder="Next >> step">
<div id="${prefix}row" data-testid="row">row</div>
<div id="${prefix}row-upper" data-testid="Row">Row</div>
<div id="${prefix}qa" data-qa="row">qa row</div>
<span id="${prefix}issues-count" title="Issues count">3</span>
<img id="${prefix}logo-full" alt="Playwright logo" width="10" height="10">
<label for="${prefix}email">E-mail address</label><input id="${prefix}email">
<label>Email<input id="${prefix}email-short"></label>
<label for="${prefix}phone">Phone</label><input id="${prefix}phone">
<label for="${prefix}go-next">Go >> next</label><input id="${prefix}go-next">
<form id="${prefix}form">
  <textarea id="${prefix}search-users" placeholder="search users"></textarea>
  <div id="${prefix}row-2" data-testid="row-2">row two</div>
  <abbr id="${prefix}issues" title="issues">I</abbr>
  <img id="${prefix}logo" alt="logo" width="10" height="10">
</form>
<div id="${prefix}shadow-host"><template shadowrootmode="open">
  <input id="${prefix}shadow-field" placeholder="Shadow field">
  <div><template shadowrootmode="open"><img id="${prefix}shadow-avatar" alt="Shadow avatar" width="10" height="10"></template></div>
</template></div>
<div><template shadowrootmode="closed">
  <input placeholder="Shadow field closed">
  <img alt="Shadow avatar closed" width="10" height="10">
</template></div>
<p>Enough visible text for the readiness probe to accept this document.</p>`;

const FIXTURE = `data:text/html,${encodeURIComponent(`<!DOCTYPE html><html><body>
${markup("p-")}
<iframe name="inner" srcdoc="${markup("f-").replaceAll('"', "&quot;")}<button id=&quot;f-ready&quot;>ready</button>"></iframe>
</body></html>`)}`;

// [getter, argument, options, expected ids without the container prefix, in document order]
const CASES = [
  ["getByPlaceholder", "search", {}, ["search-docs", "search", "search-users"]],
  ["getByPlaceholder", "Search", { exact: true }, ["search"]],
  ["getByPlaceholder", /docs$/, {}, ["search-docs"]],
  // `>>` chains locator steps, so a value containing it must stay one attribute step.
  ["getByPlaceholder", "next >> step", {}, ["next-step"]],
  ["getByPlaceholder", /^Next >> step$/, {}, ["next-step"]],
  ["getByPlaceholder", "shadow field", {}, ["shadow-field"]],
  ["getByTestId", "row", {}, ["row"]],
  // A global RegExp keeps lastIndex between test() calls; every element must be tested from the start.
  ["getByTestId", /^row/g, {}, ["row", "row-2"]],
  ["getByTitle", "ISSUES", {}, ["issues-count", "issues"]],
  ["getByTitle", "issues", { exact: true }, ["issues"]],
  ["getByTitle", /count/i, {}, ["issues-count"]],
  ["getByAltText", "LOGO", {}, ["logo-full", "logo"]],
  ["getByAltText", "logo", { exact: true }, ["logo"]],
  ["getByAltText", /^Playwright/, {}, ["logo-full"]],
  ["getByAltText", /^Shadow avatar/, {}, ["shadow-avatar"]],
  // getByLabel (#172) resolves to the labelled control. A RegExp tests the label text, flags included.
  ["getByLabel", /e-?mail/i, {}, ["email", "email-short"]],
  ["getByLabel", /^Phone$/, {}, ["phone"]],
  ["getByLabel", /mail/g, {}, ["email", "email-short"]],
  ["getByLabel", /^Go >> next$/, {}, ["go-next"]],
  ["getByLabel", "mail", {}, ["email", "email-short"]],
  ["getByLabel", "Email", { exact: true }, ["email-short"]],
];

// [getter, argument, expected ids] chained from `locator("#form")`: only the match inside the form remains.
const CHAINED = [
  ["getByPlaceholder", "search", ["search-users"]],
  ["getByTestId", /^row/, ["row-2"]],
  ["getByTitle", "issues", ["issues"]],
  ["getByAltText", "logo", ["logo"]],
];

async function launch() {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-getby-test-"));
  let connection;
  try {
    connection = await connectPipe({
      browserPath: SHELL,
      browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
      storageRoot: ud,
    });
  } catch (error) {
    removeTreeSync(ud);
    throw error;
  }
  return { connection, cleanup: async () => { await connection.close(); removeTreeSync(ud); } };
}

// Each locator goes through count(), all() and single-element resolution (getAttribute on nth()), which run separate
// in-page queries.
async function idsOf(locator) {
  const count = await locator.count();
  const fromAll = await Promise.all((await locator.all()).map((item) => item.getAttribute("id")));
  const fromNth = [];
  for (let index = 0; index < count; index++) fromNth.push(await locator.nth(index).getAttribute("id"));
  assert.deepEqual(fromAll, fromNth, `${locator} resolves the same elements through all() and nth()`);
  return fromNth;
}

test("getByPlaceholder/TestId/Title/AltText/Label match like Playwright on page, frame, frame locator and locator", { skip: !SHELL && "no chromium binary found", timeout: 120000 }, async () => {
  const { connection, cleanup } = await launch();
  try {
    const page = (await createAgentTabs(connection).create("about:blank")).page;
    await page.goto(FIXTURE);
    const frameLocator = page.frameLocator("iframe");
    await frameLocator.locator("#f-ready").waitFor();
    const frame = page.frames().find((candidate) => candidate.name() === "inner");
    assert.ok(frame, "the child frame is listed");

    const containers = [["page", page, "p-"], ["frame", frame, "f-"], ["frameLocator", frameLocator, "f-"]];
    for (const [containerName, container, prefix] of containers) {
      for (const [getter, argument, options, expected] of CASES) {
        const label = `${containerName}.${getter}(${argument}, ${JSON.stringify(options)})`;
        assert.deepEqual(await idsOf(container[getter](argument, options)), expected.map((id) => prefix + id), label);
      }
      const form = container.locator(`#${prefix}form`);
      for (const [getter, argument, expected] of CHAINED) {
        const label = `${containerName}.locator("#form").${getter}(${argument})`;
        assert.deepEqual(await idsOf(form[getter](argument)), expected.map((id) => prefix + id), label);
      }
    }

    await page.getByPlaceholder("Search", { exact: true }).fill("typed");
    assert.equal(await page.evaluate("document.getElementById('p-search').value"), "typed", "actions resolve the getter's element");
    await page.getByPlaceholder("shadow field").fill("typed in shadow");
    assert.equal(
      await page.evaluate("document.getElementById('p-shadow-host').shadowRoot.getElementById('p-shadow-field').value"),
      "typed in shadow",
      "actions reach an element inside an open shadow root",
    );
    await frameLocator.getByPlaceholder("users").fill("typed in frame");
    assert.equal(await frameLocator.locator("#f-search-users").inputValue(), "typed in frame");

    selectors.setTestIdAttribute("data-qa");
    try {
      assert.deepEqual(await idsOf(page.getByTestId("row")), ["p-qa"], "a configured test id attribute replaces data-testid");
      assert.deepEqual(await idsOf(frameLocator.getByTestId("row")), ["f-qa"]);
    } finally {
      selectors.setTestIdAttribute("data-testid");
    }
    assert.deepEqual(await idsOf(page.getByTestId("row")), ["p-row"]);
  } finally {
    await cleanup();
  }
});

// getByRole (#171) skips what Playwright's isElementHiddenForAria hides: display:none (the `hidden` attribute's default
// style included) or aria-hidden="true" on the element or any ancestor across shadow hosts, a computed visibility other
// than visible, checkVisibility() false (closed <details>), and light-DOM children their shadow root does not slot.
// `includeHidden: true` matches them all. Playwright's other getters have no such option and keep matching hidden elements.
// [button id, hidden from the accessibility tree], in role traversal order: light DOM first, then open shadow roots.
const ROLE_HIDDEN_CASES = [
  ["visible", false],
  ["display-none", true],
  ["hidden-attribute", true],
  ["hidden-overridden", false],
  ["aria-hidden", true],
  ["visibility-hidden", true],
  ["visibility-restored", false],
  ["closed-details", true],
  ["unslotted", true],
  ["list-hidden", true],
  ["list-visible", false],
  ["shadow-in-hidden-host", true],
];

const ROLE_HIDDEN_FIXTURE = `data:text/html,${encodeURIComponent(`<!DOCTYPE html><html><body>
<button id="visible">Go</button>
<div style="display: none"><button id="display-none">Go</button></div>
<div hidden><button id="hidden-attribute">Go</button></div>
<button id="hidden-overridden" hidden style="display: inline-block">Go</button>
<div aria-hidden="true"><span><button id="aria-hidden">Go</button></span></div>
<div style="visibility: hidden"><button id="visibility-hidden">Go</button><button id="visibility-restored" style="visibility: visible">Go</button></div>
<details><summary>More</summary><button id="closed-details">Go</button></details>
<div><template shadowrootmode="open"><p>No slot</p></template><button id="unslotted">Go</button></div>
<div id="list"><span hidden><button id="list-hidden">Go</button></span><button id="list-visible">Go</button></div>
<div style="display: none"><template shadowrootmode="open"><button id="shadow-in-hidden-host">Go</button></template></div>
<p>Enough visible text for the readiness probe to accept this document.</p>
</body></html>`)}`;

test("getByRole skips elements hidden from the accessibility tree unless includeHidden is set", { skip: !SHELL && "no chromium binary found", timeout: 120000 }, async () => {
  const { connection, cleanup } = await launch();
  try {
    const page = (await createAgentTabs(connection).create("about:blank")).page;
    await page.goto(ROLE_HIDDEN_FIXTURE);
    const all = ROLE_HIDDEN_CASES.map(([id]) => id);
    const exposed = ROLE_HIDDEN_CASES.filter(([, hidden]) => !hidden).map(([id]) => id);
    // count() and nth() run the two in-page role queries (counting and single-element resolution). idsOf() is not used:
    // all() on a role locator yields the locator itself rather than one locator per match.
    const roleIds = async (locator) => {
      const ids = [];
      for (let index = 0, count = await locator.count(); index < count; index++) ids.push(await locator.nth(index).getAttribute("id"));
      return ids;
    };

    assert.deepEqual(await roleIds(page.getByRole("button", { name: "Go" })), exposed);
    assert.deepEqual(await roleIds(page.getByRole("button", { name: "Go", includeHidden: true })), all);
    assert.deepEqual(await roleIds(page.locator("#list").getByRole("button", { name: "Go" })), ["list-visible"]);
    assert.deepEqual(await roleIds(page.locator("#list").getByRole("button", { name: "Go", includeHidden: true })), ["list-hidden", "list-visible"]);
    assert.equal(await page.getByText("Go", { exact: true }).count(), all.length, "getByText has no includeHidden option and matches hidden elements");
  } finally {
    await cleanup();
  }
});
