import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, globSync, readdirSync, readlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { connectPipe, compactSnapshot, createAgentTabs } from "../src/index.js";
import { removeTreeSync } from "./fixtures/remove-tree.mjs";
import { windowsSystemTool } from "../src/owner-only.js";

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

const FIXTURE_PAGE = "<!doctype html><title>Example Domain</title><main><h1>Example Domain</h1>"
  + "<p>A local page for the pipe transport test, with enough text for the content readiness probe.</p>"
  + "<a href=\"#more\">More information</a></main>";

async function serveFixturePage() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(FIXTURE_PAGE);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

// Linux reads /proc directly (lsof is often absent there); Windows has no lsof, so it asks the TCP stack
// through Get-NetTCPConnection (IPv4 and IPv6, locale-independent); macOS lsof exits 1 when nothing matches.
function listeningTcpSockets(pid) {
  if (process.platform === "win32") {
    // No match is reported as an ObjectNotFound error: that alone means "nothing listens". Any other error, or a
    // missing cmdlet, fails the call instead of reading as an empty list.
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$found = Get-NetTCPConnection -State Listen -OwningProcess ${pid} -ErrorAction SilentlyContinue -ErrorVariable failures`,
      "$other = @($failures | Where-Object { $_.CategoryInfo.Category -ne 'ObjectNotFound' })",
      "if ($other.Count -gt 0) { [Console]::Error.WriteLine(($other | Out-String)); exit 2 }",
      "$found | ForEach-Object { \"$($_.LocalAddress):$($_.LocalPort)\" }",
      "exit 0",
    ].join("; ");
    return execFileSync(windowsSystemTool("WindowsPowerShell\\v1.0\\powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
  }
  if (process.platform !== "linux") {
    try {
      return execFileSync("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", String(pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    } catch (error) {
      assert.equal(error.status, 1, `lsof failed: ${error.message}`);
      return [];
    }
  }
  const inodes = new Set();
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    let target = "";
    try { target = readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; } // fd closed since readdir
    const match = /^socket:\[(\d+)\]$/.exec(target);
    if (match) inodes.add(match[1]);
  }
  const listening = [];
  for (const table of ["tcp", "tcp6"]) {
    for (const row of readFileSync(`/proc/${pid}/net/${table}`, "utf8").trim().split("\n").slice(1)) {
      const cols = row.trim().split(/\s+/);
      if (cols[3] === "0A" && inodes.has(cols[9])) listening.push(`${table} ${cols[1]}`);
    }
  }
  return listening;
}

test("pipe transport drives Chromium with zero listening TCP ports", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-test-"));
  const fixture = await serveFixturePage();
  const connection = await connectPipe({
    browserPath: SHELL,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
    storageRoot: ud,
  });
  try {
    const pid = connection.browserProcess?.pid;
    assert.ok(pid > 0, "browser process pid");

    assert.deepEqual(listeningTcpSockets(pid), [], "browser must not listen on any TCP port");

    const page = (await createAgentTabs(connection).create("about:blank")).page;
    await page.goto(fixture.url);
    assert.equal(await page.title(), "Example Domain");
    // goto() resolves on the content probe; the committed URL lands with the main-frame
    // navigation event, which can trail the probe under load. Wait for that state.
    await page.waitForURL(fixture.url, { timeout: 10_000 });
    assert.equal(page.url(), fixture.url);

    const snapshot = await page.snapshot();
    const tree = compactSnapshot(snapshot);
    assert.ok(tree.includes('heading "Example Domain"'));
    assert.ok(tree.includes("[ref=e1]"));

    const fullBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
    const compactBytes = Buffer.byteLength(tree, "utf8");
    assert.ok(compactBytes < fullBytes, "compact tree smaller than full snapshot");
  } finally {
    await connection.close();
    await new Promise(resolve => fixture.server.close(resolve));
    removeTreeSync(ud);
  }
});

// Contract: a stale ref is re-found only when its role and name were unique in the snapshot and
// are unique now. With two look-alike buttons re-rendered in a new order, the action must fail
// instead of acting on the other row; a unique button that was re-rendered is still found.
test("stale ref recovery refuses look-alike elements and keeps unique ones", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const html = `<!doctype html><title>rows</title><ul id="rows"><li>Alpha <button data-id="a">Delete</button></li><li>Beta <button data-id="b">Delete</button></li></ul><button id="save">Save</button><p id="log"></p>
<script>
document.addEventListener("click", (event) => { const id = event.target.dataset?.id ?? event.target.id; if (id) document.getElementById("log").textContent += id + ";"; });
window.rerender = () => {
  const rows = document.getElementById("rows");
  rows.innerHTML = '<li>Beta <button data-id="b">Delete</button></li><li>Alpha <button data-id="a">Delete</button></li>';
  document.getElementById("save").replaceWith(Object.assign(document.createElement("button"), { id: "save", textContent: "Save" }));
};
</script>`;
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-stale-"));
  const browser = await connectPipe({ browserPath: SHELL, browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`], storageRoot: ud });
  try {
    const page = await browser.newTab(`data:text/html,${encodeURIComponent(html)}`);
    const { refs } = await page.snapshot();
    const refOf = (name, nth) => Object.entries(refs).filter(([, meta]) => meta.role === "button" && meta.name === name)[nth][0];
    const alphaDelete = refOf("Delete", 0);
    const save = refOf("Save", 0);
    await page.evaluate("window.rerender()");
    await assert.rejects(page.locator(alphaDelete).click({ timeout: 2000 }));
    await page.locator(save).click({ timeout: 5000 });
    assert.equal(await page.evaluate("document.getElementById('log').textContent"), "save;");
  } finally {
    await browser.close();
    removeTreeSync(ud);
  }
});

test("JavaScript dialogs are auto-accepted and surfaced as events", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-dialog-test-"));
  const connection = await connectPipe({
    browserPath: SHELL,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`],
    storageRoot: ud,
  });
  try {
    const page = (await createAgentTabs(connection).create("about:blank")).page;
    const events = [];
    page.on("dialog", dialog => events.push(dialog));

    await page.evaluate("alert('hello')");
    assert.equal(await page.evaluate("confirm('proceed?')"), true, "confirm() auto-accepts to true");
    assert.equal(await page.evaluate("prompt('name?', 'dflt')"), "", "prompt() auto-accepts to empty string");

    assert.equal(events.length, 3, "every dialog surfaces as an event");
    assert.deepEqual(events.map(d => d.type()), ["alert", "confirm", "prompt"]);
    assert.equal(events[0].message(), "hello");
    assert.equal(events[2].defaultValue(), "dflt");

    const t0 = Date.now();
    await page.goto("data:text/html,<script>alert('during load')</script><main><h1>Substantial text content for the readiness probe</h1><a href='https://example.com'>link</a></main>");
    assert.ok(Date.now() - t0 < 15000, "goto with a load-time dialog completes via the content probe");
    assert.equal(await page.evaluate("document.readyState"), "complete");
  } finally {
    await connection.close();
    removeTreeSync(ud);
  }
});

// Contract: goto resolves on a fully loaded page that is short or is a frameset. Before this,
// the content probe kept such pages "sparse" and goto threw after its whole 30 s budget.
test("goto resolves on a loaded sparse page and on a frameset page", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const pages = {
    "/sparse": "<!doctype html><title>sparse</title><h1>Done</h1>",
    "/frameset": "<!doctype html><title>frameset</title><frameset cols=\"50%,50%\"><frame src=\"/left\"><frame src=\"/right\"></frameset>",
    "/left": "<!doctype html><body>LEFT</body>",
    "/right": "<!doctype html><body>RIGHT</body>",
  };
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(pages[request.url] ?? "");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-sparse-"));
  const browser = await connectPipe({ browserPath: SHELL, browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${ud}`], storageRoot: ud });
  try {
    const page = await browser.newTab("about:blank");
    for (const route of ["/sparse", "/frameset"]) {
      const started = Date.now();
      await page.goto(`${origin}${route}`);
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 8000, `${route} took ${elapsed} ms`);
      assert.equal(await page.title(), route.slice(1));
    }
    assert.ok((await page.snapshot()).tree.length > 0);
  } finally {
    await browser.close();
    removeTreeSync(ud);
    await new Promise(resolve => server.close(resolve));
  }
});

// Public locator contract (#129): getByRole, getByText and getByLabel see elements inside open
// shadow roots, nested ones included, and never inside closed roots. Count and action resolution
// run separate in-page queries, so both are exercised against a real browser.
test("role, text and label locators pierce nested open shadows but not closed ones", { skip: !SHELL && "no chromium binary found", timeout: 60000 }, async () => {
  const ud = mkdtempSync(path.join(tmpdir(), "omowright-shadow-role-"));
  const browser = await connectPipe({ browserPath: SHELL, browserArgs: ["--headless", `--user-data-dir=${ud}`], storageRoot: ud });
  try {
    const page = await browser.newTab("about:blank");
    await page.evaluate(() => {
      document.body.innerHTML = '<button>Save light</button><div id="host"></div><div id="closed"></div>';
      const shadow = document.querySelector("#host").attachShadow({ mode: "open" });
      shadow.innerHTML = '<button>Save shadow</button><p>Shadow paragraph</p>'
        + '<label for="email">Shadow email</label><input id="email"><div id="nested"></div>';
      shadow.querySelector("button").onclick = () => { document.body.dataset.clicked = "shadow"; };
      shadow.querySelector("#nested").attachShadow({ mode: "open" }).innerHTML = '<button aria-labelledby="nested-name">x</button>'
        + '<span id="nested-name">Save nested</span><p>Nested paragraph</p><label>Nested name <input></label>';
      document.querySelector("#closed").attachShadow({ mode: "closed" }).innerHTML = '<button>Save closed</button>'
        + '<p>Closed paragraph</p><label for="c">Closed email</label><input id="c">';
    });

    assert.equal(await page.getByRole("button", { name: "Save shadow" }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Save nested", exact: true }).count(), 1);
    assert.equal(await page.getByRole("button", { name: /^Save/ }).count(), 3);
    assert.equal(await page.getByRole("button", { name: "Save closed" }).count(), 0);
    await page.getByRole("button", { name: "Save shadow" }).click();
    assert.equal(await page.evaluate("document.body.dataset.clicked"), "shadow");

    assert.equal(await page.getByText("Shadow paragraph").textContent(), "Shadow paragraph");
    assert.equal(await page.getByText("Nested paragraph").count(), 1);
    assert.equal((await page.locator("#host").locator("text:Nested paragraph").all()).length, 1);
    assert.equal(await page.getByText("Closed paragraph").count(), 0);

    await page.getByLabel("Shadow email").fill("shadow@example.com");
    assert.equal(await page.evaluate("document.querySelector('#host').shadowRoot.querySelector('#email').value"), "shadow@example.com");
    assert.equal(await page.getByLabel("Nested name").count(), 1);
    assert.equal(await page.getByLabel("Closed email").count(), 0);

    // 150k elements in one shadow scope exceed the engine's argument limit, so a traversal that
    // spreads a NodeList into push() throws RangeError here instead of matching.
    await page.evaluate(() => {
      const bulk = document.createElement("div");
      bulk.innerHTML = "<i></i>".repeat(150000) + "<p>Bulk paragraph</p>";
      document.querySelector("#host").shadowRoot.querySelector("#nested").shadowRoot.append(bulk);
    });
    assert.equal(await page.getByText("Bulk paragraph").count(), 1);
  } finally {
    await browser.close();
    removeTreeSync(ud);
  }
});
