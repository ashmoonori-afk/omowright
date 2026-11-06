# Quickstart — connections, pages, snapshots

## Runtime

Bun >= 1.4 recommended (`bun test` runs the suite as-is); Node >= 22 supported
(`node --test`). Same source, no build step.

## Two transports

```js
const { connect, connectPipe } = await import("omowright");
```

- `connectPipe({ browserPath, browserArgs, storageRoot })` — launches a browser
  over `--remote-debugging-pipe`. Zero TCP listeners (verified with `lsof`),
  nothing for other processes to hijack. Default choice. Returns an object with
  `newTab(url)`.
- `connect("http://127.0.0.1:9222")` — attaches to a running Chromium started
  with `--remote-debugging-port`, or a user's own Chrome with remote debugging
  enabled from `chrome://inspect/#remote-debugging` (its `DevToolsActivePort`
  names the port and the `ws://127.0.0.1:<port>/devtools/browser/<id>` URL;
  `connect()` takes either). Use for a real user browser (its
  profile, cookies, logins); pair with `createChromeApi` for bookmarks/history.
  Returns a `BrowserConnection` with `newTab(url)`.
- `connectRunningBrowser({ browser })` — finds that port for you: it reads
  `DevToolsActivePort` in each known browser profile, keeps the one whose port
  answers (a TCP check, so no prompt), and connects to its exact WebSocket URL.
  It never edits the profile. Two live browsers throw `choose_browser`; none
  throws `not_found`, which means the user has not allowed remote debugging yet.
  It works where an extension-based attach is blocked, for example a page that
  holds another extension's iframe.

**Every NEW connection to a user's own Chrome shows them an "Allow remote
debugging?" prompt.** `connect()` calls in one process share one connection
per browser, and `close()` releases your handle (the last release disconnects).
So keep ONE handle for the whole job: across eval cells, store it on
`globalThis` and reuse it instead of connecting (and closing) in every cell.

```js
globalThis.userBrowser ??= await connect("http://127.0.0.1:9222"); // one prompt
const page = await userBrowser.newTab("https://example.com");
// ... work, in this cell and later ones ...
await page.close();
// at the very end of the job:
await userBrowser.close();
```

Always launch with a dedicated `--user-data-dir` (a `mkdtemp` dir) and delete it
after `browser.close()`. Under Node, `node:sqlite` loads lazily with a
`bun:sqlite` fallback under Bun (see Runtime above).

## Page essentials

```js
const page = await browser.newTab(url);        // waits for interactivity
await page.goto(url);                          // content-probe readiness
await page.goto(url, { waitUntil: "commit" }); // escape hatch for tiny pages
await page.title(); page.url();
await page.evaluate("document.readyState");
await page.screenshot({ path, fullPage?, clip?, type?, quality? });
await page.pdf({ path, format?, margin? });
await page.locator("e1").click();              // ref or CSS
await page.locator("input[name=q]").fill("text");
await page.keyboard.press("Enter"); await page.mouse.wheel(0, 400);
await page.close();
```

## Snapshot discipline

```js
const snap = await page.snapshot();            // { tree, refs } or JSON string
const tree = compactSnapshot(snap);            // raw tree, ~57% smaller
await page.snapshot({ interactive: true });    // controls, headings, landmarks and state feedback
await page.snapshot({ maxDepth: 20, maxChars: 4000, selector: "main" });
```

Tree lines look like `- link "Learn more" [ref=e1]` — feed `e1` to
`page.locator("e1")`. **EVERY NEW SNAPSHOT INVALIDATES EARLIER REFS**: re-snapshot
after each state change, never act on a stale ref. Start with
`interactive: true`; escalate to a full snapshot when a target or needed text is
missing or truncated. Interactive reads keep capped text for clickable nodes,
scrollable containers and live regions: roles alert, alertdialog, status, log,
timer and marquee, and any `aria-live="polite"` or `"assertive"` element such as
a toast (`aria-live="off"` text is dropped). Scrollable containers
can retain up to 100 characters of body prose; other free-standing body prose is
omitted.

## Readiness and dialogs

Both are transport-level contracts documented once, in
`TOOLS.md` at the package root (sections "Readiness
probe" and "Dialogs"). Short form: `goto` waits for meaningful content, not
`readyState`, and times out after 30s on near-empty pages (`waitUntil: "commit"`
is the escape hatch); every JavaScript dialog is auto-accepted unless a dialog
policy says otherwise, and observable via `page.on("dialog")`, where a listener
can also answer it (`dialog.accept(text)` / `dialog.dismiss()`) instead of the policy.

## Errors worth knowing

- `RefStaleError` — the element vanished after your snapshot; re-snapshot.
- `UnsupportedOperationError` — extension-bridge feature (password managers,
  `OmO.*` extension commands, MV3 write methods). Not available standalone.
