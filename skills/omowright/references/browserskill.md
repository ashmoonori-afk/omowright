# Attached engine: the user's own browser through BrowserSkill

OmOWright has two engines. The **owned** engine (`connectPipe`,
`connectCloakProfile`) launches a browser you control. The **attached** engine
drives the browser the user is already signed into, through Tencent
BrowserSkill (stock `bsk` daemon + Web Store extension, no fork). Pick the
attached engine when the task needs the user's sessions, cookies, or their
open tabs; pick the owned engine for scraping, WAF targets, headless runs, and
anything that should not touch the user's profile.

## Core loop

```js
const { connectBrowserSkill, bskSnapshot } = await import("omowright");

const session = await connectBrowserSkill({ name: "book a table", focused: false });
await session.navigate("https://example.com/");
const sync = () => session.cooperate("sync").then((r) => r.context_id);
const { tree, refs, css } = await bskSnapshot(session, { interactive: true, context: await sync() });
// tree and refs look exactly like page.snapshot(); css[ref] is a light-DOM
// selector for the same element (null inside shadow roots)
await session.click({ selector: css.e3 }, { context: await sync() });   // or "@e3" after session.observe()
await session.fill(css.e5, "hello", { clearBefore: true, context: await sync() });
await session.press("Enter", { context: await sync() });
await session.waitForNavigation({ waitUntil: "load" });
await session.stop();                                // ALWAYS: returns borrowed tabs, closes the Agent Window
```

### Shared control (BrowserSkill 0.4+)

The person at the keyboard can work in the task tab while the agent does. The
extension therefore refuses every page action with `permission_denied` /
`data.reason: "cooperation_sync_required"` unless it carries the
`context_id` of the latest `session.cooperate("sync")`. A context is good
for one action: sync, decide from what the sync reported, act with
`{ context }`, then sync again. Gated: navigation (except the first
navigation of the untouched blank tab), every input method, `evaluate` (and
so `bskSnapshot`), `tabClose`, `resize`, `emulate`, `observe` with
`probeHover`, and `screenshot({ fullPage: true })`. Reads (`observe`,
`snapshot`, `getHtml`, `screenshot()`, `console`, `network`,
`waitForNavigation`) need no context. `dependsOn: ["@e2", ...]` narrows the
check to the observed regions the decision used.

On `cooperation_sync_required`, call `session.cooperate("wait", { timeoutMs })`
(at most 25 s) until it reports `ready`, sync again and replan from the live
page; never replay the refused action blindly. `user_aborted` means the
person stopped the task.

`connectBrowserSkill` talks to the daemon over its Unix-socket IPC directly —
no `bsk` process per call. It starts the daemon if needed (`bsk status`),
unless `BSK_AUTO_START=0`. On Windows, a host that forbids Job Object
breakaway makes `bsk status` refuse to detach; the library then registers a
per-user `bsk-daemon-<hash>` scheduled task that runs `bsk daemon start
--foreground` under `conhost.exe --headless`, so no console window opens.
It never falls back to a headless browser: when no
extension is connected it throws `no_browser_connected` and `bskDoctor()`
tells you the one step that is missing.

## What the session can do

Every method maps 1:1 onto a daemon `tool.*` method; parameters are the
daemon's own names in camelCase (`waitUntil`, `clearBefore`, `maxTokens`).
Targets are a ref (`"e3"` / `"@e3"` from `session.observe()` or
`session.snapshot()`), a CSS selector, or `{ captureId, x, y }` from a
screenshot.

| Need | Call |
| --- | --- |
| Navigate / history | `navigate(url, {waitUntil, timeoutMs})`, `back()`, `forward()`, `reload({hard})`, `waitForNavigation()` |
| Read the page | `observe({maxTokens, cursor, probeHover})` (VOM text with `@eN` refs), `snapshot()`, `getHtml({ref, maxBytes})`, `bskSnapshot(session)` (OmOWright tree + css) |
| Act | `click(target, {button, clickCount, modifiers})`, `hover`, `fill(target, value)`, `press(key, {target, holdMs})`, `select(target, values)`, `focus`, `blur`, `scrollTo`, `wheel({deltaY})` |
| Script | `evaluate(expression, {awaitPromise, timeoutMs})` → `{ok, value, error}`; Agent Window tabs only |
| Pixels | `screenshot({ref})` → `{buffer, width, height, captureId}`; `screenshot({fullPage: true})` streams the capture back in chunks |
| Tabs | `tabList({scope: "user"})`, `tabCreate({url})`, `tabSelect(id)`, `tabClose(id)`, `tabBorrow(id)` (the user confirms), `tabReturn(id)` |
| Humans | `requestHelp({prompt, targets, completionCriteria, timeoutMs})` for login, CAPTCHA, OTP, payment — the extension shows an overlay and waits |
| Diagnostics | `console({since})`, `network({since})` (metadata only), `emulate({overrides})`, `resize(w, h)` |

Anything the daemon refuses comes back as a `BskRpcError` with the daemon's
`code` (`not_found`, `invalid_params`, `permission_denied`, `timeout`,
`cdp_failed`, `user_aborted`, `no_browser_connected`, ...). Long calls can be
cancelled: `const h = session.client.callWithHandle(...)`, then
`session.client.cancel(h.rpcId)`.

## bskSnapshot leaves no trace

`bskSnapshot` evaluates the same page bundle `page.snapshot()` uses, wrapped so
`globalThis` is a local object: the page never sees `__omowright`, no
attribute is written, and a MutationObserver on the page counts zero records.
Refs are mapped to CSS paths (`#id` when unique, otherwise
`tag:nth-of-type(n)` chains) so a click goes through the daemon's `selector`
target. Elements inside shadow roots get `css: null` — use `session.observe()`
and its `@eN` ref for those.

The daemon itself enables `Runtime.enable` on every tab it drives (console
capture). That is BrowserSkill's stock behaviour and is a known CDP signal to
bot detection; for WAF-heavy targets use the owned engine with CloakBrowser
(`skills/omowright/references/stealth.md`).

## Onboarding: everything except one click

```js
const { bskDoctor, bskOnboard } = await import("omowright");
const report = await bskDoctor();            // {cli, daemon, browsers, primary, identification, browsersConnected, ready, nextStep}
if (!report.ready) {
  const result = await bskOnboard({ browser: knownBrowserOrUndefined, onHumanStep: (s) => console.log(s.step) });
  // result.needsChoice === true: nothing was registered; ask the user which
  //   browser they use (result.identification.candidates), then call again with
  //   { browser: "<id>" }.
  // otherwise result.humanStep is the single thing to tell the user, e.g.
  // 'Quit Aside completely and open it again; a dialog offers to enable "BrowserSkill" — click Enable.'
}
```

### Which browser gets the extension

Exactly one: the browser the user actually uses. A profile directory on disk
proves nothing — Chrome leaves one behind after a single launch — so
`identifyBrowser` ranks the installed Chromium-family browsers (Chrome, Edge,
Brave, Chromium, Arc, Dia, Vivaldi, Opera, Comet, Aside, Naver Whale) by
usage signals from `probeBrowserSignals`:

| Signal | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Default browser | LaunchServices `https` handler | `xdg-settings get default-web-browser` | `UserChoice` ProgId |
| Running now | the app bundle in `/Applications` or `~/Applications` (automation builds elsewhere do not count) | process name | `tasklist` image |
| Recent use | `Local State` / `Default/History` mtime within 7 days | same | same |

The decision, in order: an explicit `browser` option or `OMOWRIGHT_BROWSER`;
the default browser when it is also in use, or when nothing else is; the only
browser in use when no default can be read. Everything else — the default is
Safari or Firefox, the default is idle while another browser runs, several
browsers are in use, or nothing shows use — returns `needsChoice: true` with
every candidate and its signals, and registers nothing. Ask the user; if the
agent keeps a memory, look there first and record the answer.

`bskDoctor()` reports the same `identification` plus `registeredElsewhere`:
browsers that still carry an entry from an older onboarding. It never removes
them — deleting an external-extension entry uninstalls an extension the user
may have enabled; `unregisterExternalExtension({ browser })` does it on request.

`bskOnboard` runs, in order: the official `install.sh` / `install.ps1` into
`~/.local/bin` (any PATH lines the installer appends to shell rc files are
reverted — the library calls the binary by absolute path); `bsk status` to
start the daemon; then, for the identified browser only, Chrome's
external-extension registration for the Web Store listing:

| Platform | Where the entry goes | What the user does |
| --- | --- | --- |
| macOS | `<user data dir>/External Extensions/<id>.json` | relaunch the browser, click **Enable** once |
| Windows | `HKCU\Software\<vendor>\<browser>\Extensions\<id>` (`reg add`, no admin) | click **Enable** on the toolbar badge; no restart |
| Linux (Chromium) | `<user data dir>/External Extensions/<id>.json` | relaunch; installs silently |
| Linux (Chrome/Edge/Brave) | `/opt/google/chrome/extensions/<id>.json` etc. — needs root | otherwise: open the store link and click Add |
| Opera, and Vivaldi/Whale off macOS | no external-extension path | open the store link in that browser and click Add |

Then it waits on `system.status{wait_for_browser_ms}` until the extension
connects. Tell the user exactly `result.humanStep`, nothing more. If the user
uninstalled the extension from the browser UI earlier, Chrome blocklists the
id for external installs; `registerExternalExtension` detects that
(`reason: "blocklisted"`) and returns the store link instead.

Do not use enterprise policies (`ExtensionInstallForcelist`) from this
library: they brand the browser "managed by your organization" and the user
cannot remove the extension.

## Remote browsers

The daemon that owns the user's browser must be reachable over its Unix
socket. On another machine, run the library where the daemon is (for example
through a machine mesh), or pair the extension to a daemon in server mode
(`bsk daemon start --mode server`, WSS required off loopback). Windows named
pipes are not discovered automatically; pass `sockPath` explicitly.
