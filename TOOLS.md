# OmOWright tools — agent-facing reference

Drive a browser with Playwright-shaped JS. Two transports: `connectPipe`
(launch a browser, zero TCP port) and `connect(cdpHttpUrl)` (attach to a
running Chromium DevTools endpoint).

## Core loop

1. Open or attach a tab: `connection.newTab(url)` / `connection.attachPage(targetId)`.
2. Read the page with `page.snapshot()` — never `page.content()` for reading.
3. Act through `page.locator(refOrCss)` using `[ref=eN]` ids from the snapshot.

## Tools

- `newTab(url)` — open a tab, waits for interactivity, returns page.
- `listTargets()` — list open tabs (id, type, url, title).
- `attachPage(targetId)` — attach an existing tab.
- `page.goto(url)` — navigate; resolves when interactive with the main-frame
  document response (the final hop after redirects), or `null` for a
  same-document navigation such as a `#hash` change. `page.reload()`,
  `page.goBack()` and `page.goForward()` resolve the same way once the new
  document is active (they do not wait for `load`), and `null` when there is
  no history entry (also `null` when the transport emits no network events).
  The response is the object described under `page.on("request" | "response")`;
  its body stays readable after the call.
- `page.waitForURL(url, { timeout?, waitUntil? })` — wait until the page URL
  matches a Playwright glob (`**` crosses `/`, `*` does not, `{a,b}` is a
  choice, `?` is a literal question mark), a RegExp, or a predicate
  `(url: URL) => boolean`. With `waitUntil` it then waits for that load state;
  without it, it returns as soon as the URL matches.
- `page.waitForLoadState(state, { timeout? })` — `domcontentloaded` and `load`
  wait for those document events; `networkidle` waits until no request has been
  in flight for 500 ms (requests already running when the wait starts are not
  seen); `interactive` (default) and `stable` use the `goto` readiness probe.
- `page.setContent(html, { waitUntil, timeout })` — replace the document with
  `html`; waits for `load` by default (`domcontentloaded`, `networkidle`,
  `commit`), timeout 30000ms (0 disables it).
- `page.waitForTimeout(ms)` — discouraged: a fixed sleep. Wait for the state
  you need instead (`locator.waitFor`, `page.waitForURL`, `page.waitForLoadState`).
- `page.waitForEvent("popup")` / `page.on("popup", listener)` — deliver the
  newly opened page after attachment and interactivity. Subscribe before
  `window.open(...)` or a `target="_blank"` click. The result supports `url()`,
  `snapshot()`, `goto()`, and the other page methods. The old `{ url, windowName }`
  event metadata is available as `popup.popupMetadata` (`url` is the originally
  requested URL; `popup.url()` is the current URL). Only popups from agent-owned
  tabs with an active popup listener or waiter are adopted. User tabs attached
  with `attachPage()` and unobserved popups remain untouched. Adopted popups are
  registered with `createAgentTabs(connection)` and closed with its owned tabs
  or the connection. Disconnecting leaves ordinary `newTab()` tabs open.
  A popup that closes before attachment rejects its popup waiter promptly.
- `page.snapshot(options?)` — PRIMARY read. Returns `{tree, refs}`; tree lines
  look like `- link "Learn more" [ref=e1]`. Options: `maxDepth` (50),
  `maxChars`, `interactive`, `showHidden`, `selector`, `ref`.
- `compactSnapshot(snapshot)` — returns the raw tree without the refs map
  (refs resolve in-page; the map is ~54% of bytes on real pages). Use before
  sending snapshots to a model.
- `page.locator(refOrCss)` — `click`, `fill`, `press`, `pressSequentially`,
  `hover`, `check`, `selectOption`, `dragTo`, `setInputFiles`, `textContent`,
  `innerText`, `allTextContents`, `allInnerTexts`, `isVisible`, `waitFor`,
  `first/nth/last`, `filter`, `and` (both match), `or` (either matches, document order).
- `page.getByRole(role, options?)`, `getByText(text, { exact })`,
  `getByLabel(text, { exact })`, `getByPlaceholder(text, { exact })`,
  `getByAltText(text, { exact })`, `getByTitle(text, { exact })`,
  `getByTestId(testId)` — Playwright locators. Frames (`page.frames()`,
  `page.mainFrame()`), frame locators (`page.frameLocator(css)`) and locators
  (`page.locator(css).getByTestId(id)`, scoped to that locator) have the same
  getters. They match inside open shadow roots, never inside closed ones.
  For placeholder, alt text and title, a string matches a
  case-insensitive substring of the attribute, `exact: true` the whole
  case-sensitive value, and a RegExp the raw value. `getByTestId` matches
  `data-testid` exactly (or by RegExp); `selectors.setTestIdAttribute(name)`
  switches the attribute for locators created afterwards.
- `page.evaluate(expression)` — run JS in the page.
- `page.waitForRequest(urlOrPredicate, { timeout? })` /
  `page.waitForResponse(urlOrPredicate, { timeout? })` — wait for the next
  matching request or response headers (default timeout: 30000ms). Match an
  exact URL string, a RegExp, or a sync/async predicate over the object.
  Register the wait before triggering the request.
- `page.on("request" | "response", listener)` — observe traffic; the returned
  function unsubscribes, as does `page.off(event, listener)`. Both waits and
  listeners receive objects with `url()`, `method()`, `headers()` (lowercase
  names), and async `body()` (Buffer), `text()`, `json()`. Request bodies are
  the CDP request's post data; responses also expose `status()` and `ok()`
  (status 200-299). Response body reads wait for transfer completion and
  decode base64 when necessary.
  Bodies are cached on completion for response objects delivered to listeners.
  If the transport refuses `Network.getResponseBody`, these reads reject with
  the exported `NetworkBodyUnavailableError` (the transport error is `cause`),
  never `null`. Failed transfers and redirects also reject body reads.
  Network subscriptions and domain ownership are shared with
  `createNetworkSnoop()` and readiness tracking. They start on demand and
  release after the last consumer and its pending response bodies finish;
  no Runtime domain is enabled. A refused Network enable does not break page
  setup, but a transport that emits no network events will time out waits.
- `page.waitForFunction(pageFunction, arg?, { timeout, polling })` — wait for
  app-specific page state instead of sleeping. Runs `pageFunction(arg)` (a
  function, or a string expression) in the page's main world until it returns a
  truthy value, then resolves with that value by value: DOM nodes and functions
  come back as `{}`, and a value CDP cannot return by value (a cycle such as
  `window`, a symbol or a bigint) as `true`. `polling` is `"raf"` (default,
  every animation frame, or every 100 ms when the page gets no frames, as a
  background tab of a headful browser does) or a positive number of
  milliseconds. `timeout`
  defaults to 30000; `0` waits forever. A same-tab navigation during the wait
  re-runs the function in the new document. An error thrown by the function,
  or closing the page, rejects at once; a timeout rejects with
  `WaitForFunctionTimeoutError` (exported; `timeoutMs`, and the message
  carries the function source cut at 200 characters). Example:
  `await page.waitForFunction(n => document.querySelector(".badge")?.textContent === String(n), 3)`.
- `page.screenshot(options?)` — image bytes (path, fullPage, clip, type, quality).
- `page.pdf(options?)` — PDF bytes (path, format, margin, printBackground).
- `page.keyboard` / `page.mouse` — press, type, insertText / move, click, wheel.
- `page.on(event, listener)` / `page.off(event, listener)` /
  `page.waitForEvent(event, { timeout?, predicate? })` — page events; `on`
  returns an unsubscribe function. The accepted names are the exported
  `PAGE_EVENT_NAMES`: `close`, `console`, `crash`, `dialog`,
  `domcontentloaded`, `download`, `filechooser`, `frameattached`,
  `framedetached`, `framenavigated`, `load`, `pageerror`, `popup`, `request`,
  `response`. Any other name throws a `TypeError` that lists them.
  `pageerror` receives an `Error` (page `name`, `message` and `stack`) for each
  uncaught exception or unhandled rejection in the page or its frames. The
  Runtime domain it needs is enabled only while a `pageerror` or `console`
  listener exists (pages can detect it), and exceptions thrown before the
  subscription are not replayed. `close` fires once the tab is gone, whether
  `page.close()`, `window.close()`, the user or another client closed it; the
  page is disposed with it.
- `createCua(page)` — coordinate fallback (visual-browse equivalent): `click`,
  `doubleClick`, `drag({path})`, `move`, `scroll`, `type`, `keypress`,
  `getVisibleScreenshot()` (base64 PNG). Use only when refs/locators cannot
  target the UI (canvas, custom controls, stale refs).
- `createCaptcha(page, { ocr? })` — input, OCR, and explicit condition helpers,
  not a general CAPTCHA solver. `click(bounds, opts?)` defaults to the center;
  optional `opts.point` is an absolute top-level viewport CSS-pixel point inside
  the bounds. Positive integer `opts.approachSteps` adds intermediate movement,
  not a human-likeness guarantee. Re-measure after scrolling/resizing; iframe
  bounds alone do not locate a checkbox. `drag(from, to, {steps?, settleMs?})`
  defaults to 20 steps. Both return a compact snapshot tree string after
  settling (`settleMs` defaults to 3000ms, allows 0), not proof of acceptance.
  `waitFor({until, timeoutMs = 10000, pollMs = 100, signal?})` separately returns
  `{outcome: "matched" | "timed_out" | "cancelled", elapsedMs}`, with no tree.
  Use `click(bounds, {settleMs: 0})`, then an application-specific acceptance
  predicate: only literal `true` matches. Checks are serial under one deadline;
  abort takes priority over timeout, then match. Predicate errors propagate;
  cancellation cannot retract dispatched input/requests or interrupt blocking
  synchronous code. Take `page.screenshot()` separately for visual evidence.
  `readText(bounds?)` OCRs a screenshot region and returns text or `null`, never
  a tree. It defaults to macOS Vision (`macOSVisionOcr`); pass
  `ocr: async (pngBuffer) => string` on other platforms or to use a vision model.
  Full bounds, timing, cancellation, and acceptance examples:
  [CAPTCHA skill](presets/captcha/SKILL.md).
- `createChromeApi(connection, { profilePath?, downloadDir? })` — Chrome
  MV3-shaped APIs: `tabs.query/get`, `windows.get/getCurrent/getAll` (no
  `focused` field and `windows.getLastFocused` throws: CDP exposes no window
  focus), `bookmarks.*` (read-only), `history.search/getVisits`,
  `downloads.search/download`, `topSites.get`. Profile-backed methods need
  `profilePath`. Write methods throw `UnsupportedOperationError` (extension
  bridge required). Full reference: presets/chrome/.
- `injectCookies(page, cookies)` — inject raw cookie exports (e.g. from a
  real browser profile) with CDP sanitization handled: negative `expires`
  dropped, `__Host-` cookies forced secure + root path + url-scoped,
  `SameSite=None` dropped when not secure, name+domain deduped.
  `sanitizeCookies(cookies)` is the pure transform if you need it.

Every tool below is exported from `src/index.js`, the same import as the core
loop; the module files next to it are implementation detail.

- `connectNamed(name, { browserPath, browserArgs, profileDir, registryRoot?,
  dialogPolicy?, probeTimeoutMs?, launchTimeoutMs?, connectTimeoutMs?,
  lockTimeoutMs? })`:
  attach-or-launch a named Chromium. A healthy registered instance is attached;
  a stale record is cleaned up and relaunched; a live pid whose recorded port
  refuses connections, or answers as a different browser, is treated as a reused
  pid (stale → relaunch), while an endpoint that hangs or answers wrongly throws
  an `unresponsive holder` error naming the holder (name, pid, endpoint). The
  record stores the browser's `webSocketDebuggerUrl` (it carries the browser
  GUID) and an attach happens only while the endpoint still answers with it, so
  a reused pid plus a rebound port cannot hand you a stranger's browser. Every
  wait is bounded: discovery by `probeTimeoutMs`, the launch by
  `launchTimeoutMs`, the CDP handshake by `connectTimeoutMs`, the registry lock
  by `lockTimeoutMs` (default: the other three plus a margin).
  The registry lock has two known races when a takeover meets a live holder:
  two callers can hold a name for a moment, and a released lock can come back
  and block the name until its holder's process exits (tracked in #62).
  **The named endpoint is unauthenticated.** CDP listens on 127.0.0.1 with a
  kernel-chosen port: off the network, but any local process or user can drive
  that browser. Name-less launches (`connectPipe`, `connectCloakProfile()`
  without `name`) expose no port at all.
  `newTab()` works on both paths; `close()` from the launcher terminates the
  browser and removes its record, from an attached client it only detaches.
  Attaches in one process share one CDP connection per browser, because
  Chrome asks the user to allow remote debugging once per connection: each
  attach returns a handle on it, `close()` releases that handle, and the last
  release disconnects. A dropped socket is reconnected once, and a browser
  with another GUID always gets its own connection. Callers passing different
  connection options (storage root, client options, `dialogPolicy`) are not
  shared. A holder never changes what another holder gets: on a shared handle
  `setDialogPolicy` throws `SharedConnectionError` (`error.code ===
  "shared_connection"`; pass `dialogPolicy` when attaching instead), a sole holder's `setDialogPolicy` works and that
  connection is never shared again, properties set on a handle stay on it,
  writing or defining `cdp`, `close` or `setDialogPolicy` on a handle throws
  `TypeError`, the shared client can't be written through it, and listeners
  added through `handle.cdp` are removed by that handle's `close()`.
  `handle.cdp.transportEvents.clearListeners()` removes only that handle's
  transport listeners, and `handle.cdp.transportEvents.emit()` throws
  `TypeError`. The connection keeps a frozen copy of the options it was
  attached with, so mutating your options object after attaching changes
  nothing. `handle.cdp.dialogPolicy` on a shared connection is that frozen
  copy (or a frozen default when you passed none), not your object, so it
  can't be changed in place. `setDialogPolicy(undefined)` resets to the default (accept every
  dialog).
  `listInstances()` returns every record (`{ name, pid, endpoint,
  webSocketDebuggerUrl, profileDir, browserPath, startedAt }`) with `alive` /
  `responsive` liveness.
- `createNetworkSnoop(page, { match?, bodies=true, maxEntries=500, maxBodyBytes? })`:
  buffer finished network entries for one page. `match` is a predicate or
  `{ url: string|RegExp, method, mimeType, resourceType }`. Methods: `pop()`
  (drain), `peek()` (copy), `popJson()` (drain and parse JSON bodies),
  `waitFor(match, { timeoutMs })` (resolves with the next matching entry),
  `summary({ max })` (one line per entry: method status mime bytes url),
  `dispose()`. Entries carry `requestId, url, method, resourceType, status,
  statusText, mimeType, requestHeaders, responseHeaders, postData,
  encodedDataLength, body, base64Encoded, bodySkipped, failed, errorText,
  startedAt, finishedAt`.
- `collectWhileScrolling(page, snoop, { minItems, maxScrolls=10, extract, scroll:
  "wheel"|"end", settleMs=800 })`: async generator. Each round scrolls, settles, drains
  `snoop.popJson()` through `extract(json) => items[]`, yield each item. Returns
  `{ rounds, total, stoppedBecause: "minItems"|"maxScrolls"|"noGrowth" }`.
- `createTrace(page, { dir, screenshots=true, network=true, console=true,
  maxBodyBytes?, events? })`: flight recorder. `step(name, fn)` runs `fn` with
  before/after screenshots and timing, `mark(name, data)` drops a marker,
  `stop()` flushes and returns the summary. Writes `dir/trace.jsonl` (kinds:
  step, network, console, dialog, navigation, download, mark, warning),
  `dir/trace.har` (HAR 1.2), `dir/summary.json`, and
  `dir/screenshots/<seq>-<slug>-before|after.png`. `trace.dir` is the resolved
  directory. Never sends `Runtime.enable`.
- `toHar(entries, { creator?, pages? })`: pure HAR 1.2 builder over snoop entries.
- `reconcileFrames(page)`: re-links OOPIF child frames that lost their parent;
  returns the frames it added. `snapshotWithFrames(page, opts?)`: snapshot that
  runs the repair first and adds `missingFrames` only when a frame could not be
  entered at all. Details in "Frames (OOPIF) and shadow DOM" below.
- `requestHuman(page, { prompt, until?, timeoutMs=300000, pollMs=500, signal? })`:
  bring the window to front, show a shadow-DOM banner with a Done button, and
  wait. `until` is `{ url: string|RegExp }`, `{ selector }`, or
  `async (page) => boolean`. Resolves `{ outcome: "continued"|"timed_out"|
  "cancelled", elapsedMs, reason: "until"|"done-button"|"timed_out"|"signal" }`.
  The banner is removed on every path.
- `describeLayers(page, { grid=5 })`: hit-test a grid over the viewport and
  report `{ blocking: null | { tagName, role, name, coverage, position,
  selectorHint, ariaModal }, candidates, viewport }`. `layersHeader(result)`
  renders `@layers none` or `@layers blocking=<role|tag> "<name>" coverage=NN%
  hint=<sel>`. `snapshotWithLayers(page, opts?)` prepends that header to
  `tree` and adds a `layers` field.
- `DEVICE_PRESETS` (`"iphone-14"` 390x844 @3x touch, `"pixel-7"` 412x915,
  `"ipad-air"` 820x1180, `"desktop-1440"` 1440x900) and
  `emulate(page, nameOrPreset)`: set metrics, touch, and UA together;
  `emulate(page, null)` clears the override and restores the UA captured on the
  first call.
- `page.route(urlGlobOrRegExpOrPredicate, handler, { times }?)`,
  `page.unroute(url, handler?)`, `page.unrouteAll()`: request interception.
  Strings match the whole URL: `*` excludes `/`, `**` crosses directories,
  `{png,jpg}` matches alternatives, and `?` is literal. Predicates receive
  a `URL`. The newest matching handler runs first; `route.fallback()` passes
  to the next match, while `route.continue({ url, method, headers, postData })`
  sends directly to the network. Handlers receive `(route, request)`;
  `route.request()` returns that request, with `url()`, `method()`, `headers()`,
  `postData()` and `resourceType()`. Respond with
  `route.fulfill({ status, headers, contentType, body, json, path })` or
  `route.abort(errorCode?)` (default `"failed"`, also `"blockedbyclient"`, etc.).
  `times` limits matching invocations. Fetch stays off until registration and
  is disabled after the last route is removed or exhausted. Page methods and
  `createRoutes(page)` share one dispatcher; `unrouteAll()` clears both.
- `createRoutes(page)`: legacy request interception. `route(match, handler)`,
  `unroute(match?)`, `dispose()`, `enabled`. `match` is a glob string (`*` and
  `?`; plain substring otherwise), a RegExp, or a predicate over
  `{ url, method, resourceType, headers }`. The handler receives `{ request,
  continue(overrides), fulfill({ status, headers, contentType, body }),
  abort(reason) }`. `Fetch.enable` is sent on the first `route()` only.
- Dialog policy: `connectPipe({ dialogPolicy })`, `connect(url, { dialogPolicy })`,
  `new PipeCdpClient({ dialogPolicy })`, `client.setDialogPolicy(policy)`, `client.dialogPolicy`,
  `BrowserConnection.setDialogPolicy(policy)`. Pure helpers in
  `src/dialog-policy.js`: `normalizeDialogPolicy(policy)`,
  `resolveDialogAction(policy, dialogParams)`. See "Dialogs" below.

## Attached engine (BrowserSkill)

- `connectBrowserSkill({ name, browser, width, height, focused, home, sockPath,
  autoStart, timeoutMs })`: starts a session in the user's own browser through
  the BrowserSkill daemon's IPC socket and returns a `BskSession`. `browser`
  takes an instance id, a unique label, or a browser name such as `"chrome"`
  that exactly one connected browser carries. Throws
  `BskRpcError` `no_browser_connected` when no extension is attached; never
  launches a browser of its own.
- `BskSession`: `navigate`, `back`, `forward`, `reload`, `observe`, `snapshot`,
  `getHtml`, `screenshot({ ref, fullPage })`, `click`, `hover`, `fill`,
  `press`, `select`, `focus`, `blur`, `scrollTo`, `wheel`, `evaluate`,
  `tabList`, `tabCreate`, `tabClose`, `tabSelect`, `tabBorrow`, `tabReturn`,
  `waitForNavigation`, `requestHelp`, `console`, `network`, `resize`,
  `emulate`, `cooperate(action)`, `stop()`. Targets: `"e3"` / `"@e3"` (daemon
  refs), a CSS selector, or `{ captureId, x, y }`. BrowserSkill 0.4 refuses
  page actions (`cooperation_sync_required`) without `{ context }` from the
  latest `cooperate("sync")`; `dependsOn` narrows that check
  (`skills/omowright/references/browserskill.md`).
- `bskSnapshot(session, options)`: OmOWright `{ tree, refs, css }` from an
  attached tab with no page global and no DOM mutation; `css[ref]` is `null`
  inside shadow roots.
- `bskDoctor({ browser })` / `bskOnboard({ browser, onHumanStep })`: CLI install
  (official installer, rc-file changes reverted), daemon start, then Web Store
  extension registration through Chrome's External Extensions
  (`registerExternalExtension` / `unregisterExternalExtension`) for the one
  browser the user actually uses, then a wait on
  `system.status{wait_for_browser_ms}`. The one human step is returned as
  `humanStep`; `needsChoice: true` means nothing was registered and the user
  has to name the browser. While the daemon is down nothing is registered,
  `humanStep` is `null`, and `nextStep` says how to start the daemon; otherwise
  `nextStep` is the same step as `humanStep` (`null` once ready).
- `identifyBrowser({ catalog, signals, explicit, connected })` /
  `probeBrowserSignals()` / `catalogBrowsers()` / `detectBrowsers()`: the
  browser choice on its own — the daemon's connected `browser_name`s, default
  browser, running process and recent-use signals, ranked; ambiguity returns
  `needsChoice` instead of a guess.
- `BskIpcClient` / `BskRpcError` / `readDaemonInfo` / `resolveBskHome`: the
  raw JSON Lines IPC client (`call`, `callWithHandle`, `cancel`) for daemon
  methods the session does not wrap.

## Rules

- Ref ids are virtual: pass them straight to `page.locator('e1')`, never into
  CSS selectors. Every new snapshot invalidates earlier ref ids. Attached-engine
  refs from `session.observe()` are `@eN` strings for `session.click("@e3")`;
  `bskSnapshot` refs are clicked through `css[ref]`.
- Raw CDP `page._sendToTarget(method, params)` exists but is an escape hatch;
  prefer the tools above. There is no `page.context()`.

## Dialogs (alert / confirm / prompt / beforeunload)

Every JavaScript dialog is **answered at the transport layer**: by a `dialog`
listener that answers it, otherwise by a dialog policy, so the page never hangs
waiting for a human, including a click that triggers `window.print()`. The default policy accepts everything, which keeps
the old behaviour: `alert()` returns immediately, `confirm()` returns `true`,
`prompt()` returns `""`, `beforeunload` never blocks navigation, and dialogs
during page load are handled the same way (`page.goto()` still completes because
readiness is content-probe based).

A policy is either an object or a function:

```js
const browser = await connectPipe({ browserPath, browserArgs, storageRoot,
  dialogPolicy: { accept: false } });              // confirm() -> false, prompt() -> null
browser.setDialogPolicy({ accept: true, promptText: "agent@example.com" }); // prompt() -> the text
browser.setDialogPolicy(dialog => {               // { type, message, defaultPrompt, url }
  if (dialog.type === "beforeunload") return true;
  return { accept: !/delete/i.test(dialog.message), promptText: dialog.defaultPrompt };
});
browser.cdp.dialogPolicy;                         // read the current policy (client getter)
```

- `{ accept: false }` dismisses: `confirm()` returns `false`, `prompt()` returns
  `null`. `alert()` returns either way.
- `promptText` is the value `prompt()` resolves to when accepted.
- A function policy may return `boolean` or `{ accept, promptText }`, sync or
  async. A policy that throws falls back to accept, so a bug in the policy
  cannot hang the page.
- `connectPipe({ dialogPolicy })` and `connect(url, { dialogPolicy })` set it
  up front; `browser.setDialogPolicy()` swaps it later (it forwards to the pipe
  or WebSocket client and throws for a transport without policy support).
- `page.on('dialog', dialog => ...)` hands each listener a Playwright-style
  `Dialog`: `type()`, `message()`, `defaultValue()` (the prompt's default
  text), `url`, `accept(promptText?)` and `dismiss()`. A listener that answers
  replaces the policy for that dialog. The policy answers once the listeners
  have run and none of them answered, so a listener that only looks (a trace,
  `page.waitForEvent('dialog')`) leaves the dialog to the policy:

  ```js
  page.on("dialog", dialog =>
    dialog.type() === "prompt" ? dialog.accept("agent@example.com") : dialog.dismiss());
  ```

  Answer inside the listener or in a promise it returns: the policy waits for
  that promise. A dialog is answered once: a second `accept()` / `dismiss()`,
  or one after the policy answered, rejects.
- CDP listeners of `Page.javascriptDialogOpening` get the same `Dialog` as
  `meta.dialog`. On a shared connection the policy is the connection's and a
  listener belongs to the handle that added it: it answers until that handle
  closes, then the policy answers again.

## Frames (OOPIF) and shadow DOM

- Out-of-process iframes are stitched into the snapshot as child trees under
  the owning `- iframe [ref=eK]:` line. Child refs look like `f<N>e<M>` and go
  straight to `page.locator("f1e3")`; the page routes them to the right frame
  session. There is no separate frame object to hold.
- Plain `page.snapshot()` sees OOPIFs that existed before `attachPage()`; no
  extra call is needed for the common case.
- Closed shadow roots hide the host link, so a frame inside one lands in an
  orphan `- iframe:` block at the end of the tree. Its refs still work.
- `reconcileFrames(page)` re-links child frames whose parent link was lost (it
  returns the frames it added). `snapshotWithFrames(page)` runs that repair and
  reports `missingFrames` only when a frame could not be entered at all. Reach
  for these when a snapshot shows an `iframe` with no children you expected.
- Rough edge: the first click into a freshly adopted OOPIF can land on the
  embedder. Re-snapshot and click the ref again.

## Stealth notes

- The `Network` domain is already enabled for every page session, and pages
  cannot observe it. `createNetworkSnoop` and `createTrace` add no new signal.
- `Fetch` interception changes request timing and blocking patterns that bot
  defenses can fingerprint. It's off until the first `createRoutes().route()`
  call, and `dispose()` turns it off again. Keep routes out of stealth runs.
- None of these modules send `Runtime.enable`; `requestHuman` and
  `describeLayers` use `page.evaluate`, which shares the existing path.
- Device emulation swaps the UA and metrics; pair it with a matching
  fingerprint seed when the target scores consistency.

## Readiness probe

`page.goto()` waits for meaningful content, not just `document.readyState`:
the page is ready when `body` exists AND (interactive elements > 0 OR
landmarks > 0 OR visible text >= 20 chars). A near-empty page (e.g.
`<h1>ok</h1>`) never satisfies the probe and `goto` times out after 30s — use
`page.goto(url, { waitUntil: "commit" })` for content-free fixtures.
