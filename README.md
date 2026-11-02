# OmOWright

[![CI](https://github.com/code-yeongyu/omowright/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/code-yeongyu/omowright/actions/workflows/ci.yml)

Playwright-shaped browser automation for AI agents. The API a model already
knows, a fraction of the tokens, and the scrolling primitives real websites
need.

OmOWright exists because of one article. In [How we built the SOTA browser
agent that outperforms Fable](https://x.com/hyojun_at/article/2070234507995910413),
Jun ([@hyojun_at](https://x.com/hyojun_at)) explains how [Aside](https://aside.com)
reached #1 on Online-Mind2Web, Odyssey and BU-Bench-V1: give the model the
browser interface it was trained on (Playwright), keep every tool output
high-signal, and treat CDP as an implementation detail the model never sees.
We read it, agreed with every line, and built OmOWright on those principles.

## Why it looks like Playwright

Jun's argument is the whole design:

1. **Follow the model's training data.** LLMs have seen more Playwright than
   any other browser API, so OmOWright keeps the Playwright shape:
   `page.goto`, `page.locator(...).click()`, `page.mouse.wheel`,
   `page.keyboard.type`, `page.screenshot`, `getByRole`, `frameLocator`. No
   new vocabulary to teach in the prompt.
2. **Protect the context window.** Raw DOM and raw CDP are noise. The primary
   read is an accessibility snapshot with refs, and `compactSnapshot()` strips
   the duplicated refs map, which is about 54% of the bytes on a real page.
3. **CDP underneath, never on top.** Every method is a thin wrapper over CDP
   calls. The model writes Playwright; the library speaks the protocol.
4. **Fall back to pixels.** When the DOM lies (canvas, custom widgets,
   challenge pages), `createCua(page)` gives coordinate-level control over the
   same viewport.

```js
import { compactSnapshot, connectPipe } from "omowright";

const browser = await connectPipe({ browserPath: "/path/to/chromium", browserArgs: ["--headless"] });
const page = await browser.newTab("https://example.com");

console.log(compactSnapshot(await page.snapshot()));
// - heading "Example Domain" [level=1]
// - text: "This domain is for use in documentation examples ..."
// - paragraph:
//   - link "Learn more" [ref=e1]

await page.locator("e1").click();          // refs come straight from the snapshot
await browser.close();
```

Re-snapshots come back as a unified diff against the previous tree, so a model
reads what changed instead of the whole page again.

## Scrolling is a first-class problem

Most of the web an agent cares about is behind a scroll: feeds, search results,
tables that page over XHR, "load more" that never ends. OmOWright treats that
as a core case rather than a `mouse.wheel` loop the agent has to invent.

**Collect while scrolling.** Pages fetch their list data as JSON; reading that
is cleaner than scraping rendered rows. `createNetworkSnoop` captures the
responses and `collectWhileScrolling` drives the page until it has enough:

```js
import { createNetworkSnoop, collectWhileScrolling } from "omowright";

const snoop = createNetworkSnoop(page, { match: { url: /\/api\/feed/, mimeType: "json" } });
await page.goto("https://example.com/feed");

const items = [];
const run = collectWhileScrolling(page, snoop, {
  minItems: 200,                 // stop once this many items are in hand
  maxScrolls: 15,                // or after this many scroll rounds
  extract: (json) => json.items, // pull items out of each JSON body
  scroll: "wheel",               // "end" jumps to the bottom instead
  settleMs: 800,                 // wait for the next page to land
});
let step;
while (!(step = await run.next()).done) items.push(step.value);
step.value;                      // { rounds, total, stoppedBecause: "minItems" | "maxScrolls" | "noGrowth" }
```

It drains first, scrolls second, and stops on its own when the document stops
growing, so an agent never has to guess how many times to scroll.

**Scroll like a user.** `page.mouse.wheel(dx, dy)` dispatches a real wheel
event at the pointer, which is what lazy loaders and virtualized lists listen
for. `scroll: "wheel"` above uses exactly this from the viewport centre.

**Scroll to a ref.** `page.locator("e42").scrollIntoViewIfNeeded()` centres an
element in the viewport before you act on it.

**Scroll by coordinates.** `createCua(page).scroll({ x, y, scrollX, scrollY })`
scrolls at a point in viewport pixels for canvases, embedded panes and other
surfaces the accessibility tree does not describe.

**Wait for the request, not the clock.** `snoop.waitFor({ url, method })`
resolves when the response the scroll triggered has finished, so there is no
sleep to tune.

## Everything else in the box

- **Zero-port pipe transport.** `connectPipe()` launches Chromium with
  `--remote-debugging-pipe` and speaks CDP over inherited file descriptors. No
  `/json/*` endpoint and no listening TCP port exist for the driven browser.
  `connect(url)` attaches to an existing DevTools endpoint instead. Named
  instances are the one exception: they listen on a local `127.0.0.1` port
  chosen by the OS (`--remote-debugging-port=0`). That keeps the endpoint off
  the network, but it is unauthenticated — any local process can drive a named
  browser, which a pipe-transport browser never allows.
- **Named instances.** `connectNamed(name)` attaches to a live registered
  Chromium, relaunches a stale one, and errors naming the holder (name, pid,
  endpoint) when it is unresponsive; an attach requires the endpoint to answer
  with the browser GUID recorded at launch, so a reused pid on a rebound port is
  relaunched rather than driven. `listInstances()` lists every registered
  instance with liveness.
- **Shared attaches.** Chrome asks the user to allow remote debugging once per
  connection to their own profile, so `connect(url)` and `connectNamed`
  attaches in one process share one CDP connection per browser (keyed by its
  GUID). Each call returns a handle on it: `close()` RELEASES that handle, and
  only the last release disconnects. Pages attached through one handle are the
  same pages for every handle and stay attached until the last release. A
  handle never changes what another holder gets: on a shared connection
  `setDialogPolicy` throws `SharedConnectionError` (pass `dialogPolicy` when
  attaching to get a connection of your own), a sole holder's
  `setDialogPolicy` works and that connection is never shared again, and
  properties, client writes and listeners stay with the handle. A connection
  is never shared when an `authorizer` (or any non-plain client option) is
  set, nor between callers whose options differ (`dialogPolicy` included). A
  shared handle's reconnect never reaches a browser other than the one it
  was opened for; an unshared connection (one with an authorizer, say)
  reconnects to whatever answers on its URL.
- **Scoped endpoints.** An app can hand OmOWright a limited browser (say, one
  thread's tabs) behind a token: `connect(url, { client: { authorizer } })`
  sends `Authorization` from `authorizer.resolveAuthorization({ forceRefresh })`
  and asks once more with `forceRefresh` after a 401. Keep the token out of the
  URL. `OMOWRIGHT_PAGE_CDP_METHODS` lists every command the page API sends, so
  such an endpoint can allow exactly those and refuse the rest. The list
  includes `DOM.setFileInputFiles`, which puts a local file into a page's file
  input; the page then reads it, so a thread endpoint should only hand it paths
  the user chose. `createEvents()` needs a full endpoint (it sends
  `Browser.setDownloadBehavior`).
- **Agent signals.** `createEvents()` pushes `tabOpened`, `popupOpened`,
  `downloadStarted` / `downloadFinished` and friends, so agents stop polling.
  `createAgentTabs()` opens every tab in the background and never steals focus.
- **Frames and overlays.** OOPIF-aware snapshots, `describeLayers()` for the
  dialog or toast that swallowed your click, and a dialog policy for
  `alert` / `confirm` / `prompt`.
- **Flight recorder.** `createTrace()` writes a jsonl timeline, HAR and step
  screenshots, so a failed run is a directory to read.
- **Routes and emulation.** `createRoutes()` (Fetch domain) to fulfil or abort
  requests, `emulate()` with device presets.
- **Human handoff.** `requestHuman()` for login, OTP and consent screens.
- **Real-profile reads.** `createChromeApi()` exposes MV3-shaped tabs, windows,
  bookmarks, history, downloads and topSites over CDP and profile files; the
  bridge extension in `bridge/extension/` covers what CDP cannot see.
- **CAPTCHA helpers.** `createCaptcha()` clicks checkboxes, drags sliders and
  OCRs text regions (macOS Vision built in, any `ocr(buffer)` pluggable).
- **Stealth profiles.** `connectCloakProfile()` pins a CloakBrowser fingerprint
  seed to a persistent profile and refuses to change identity silently.
- **The user's own browser.** `connectBrowserSkill()` drives the browser the
  user is already signed into through [BrowserSkill](https://github.com/Tencent/BrowserSkill)
  (stock daemon and Web Store extension, spoken to over its IPC socket — no
  process per call). `bskSnapshot()` returns the same `{ tree, refs }` shape
  without leaving a global or a DOM attribute behind, and `bskOnboard()`
  installs the CLI, starts the daemon and registers the extension in the browser
  the user actually uses (default browser, running process, recent use; it asks
  when those disagree) so the only thing left for the user is one **Enable** click.

## Install

```bash
bun add github:code-yeongyu/omowright
```

Bun >= 1.4 is recommended; Node >= 22 is supported. Runtime dependencies are
`ws` and `zod`. OmOWright never downloads a browser: point it at any Chromium,
Chrome, a Chromium headless shell, or CloakBrowser.

## Agent skill

`skills/omowright/` is a self-contained agent skill (`SKILL.md` plus
references) that routes a model through the library: the snapshot/ref loop,
the obstacle ladder (refs, overlays, coordinates, viewport pin, CAPTCHA,
browser log), stealth profiles, eval-kernel usage, frames and human handoff,
the attached BrowserSkill engine, and reading a 1Password web-vault item
safely. Task presets live in `presets/`:

| Preset | Covers |
| --- | --- |
| `presets/network` | Snoop JSON APIs, wait for requests, **collect while scrolling**, traces, routes |
| `presets/visual-browse` | Coordinate UI, **CUA scroll**, viewport pinning, extension popups |
| `presets/captcha` | Checkbox, slider, OCR and image-grid challenges |
| `presets/chrome` | Tabs, windows, bookmarks, history, downloads, topSites |
| `presets/agent-events` | Tab, popup and download push events |
| `presets/cloak-bridge` | The MV3 bridge extension and native-messaging host |

Install the skill by copying or symlinking `skills/omowright` into your
harness's skills directory (for example `~/.agents/skills/omowright`). The
agent-facing tool reference is [`TOOLS.md`](TOOLS.md); machine-readable schemas
ship as the `toolSchemas` export.

## Persistent CloakBrowser profiles

For long-lived authenticated work, use `connectCloakProfile()` or the bundled
`omowright-cloak` launcher. The first run stores a random fingerprint seed in
`.omowright-cloak.json` (mode `0600`) inside the private profile (mode `0700`);
later runs reuse it and reject a conflicting seed. Never copy Google or
1Password cookies between profiles. Full lifecycle:
[`docs/cloakbrowser-persistent-profile.md`](docs/cloakbrowser-persistent-profile.md).

## Development

```bash
bun install
bun run test        # Bun runner
bun run test:node   # Node test runner, same files
```

Live tests need a Chromium headless shell. Set `SHELL_BIN` (and
`CLOAKBROWSER_BIN` for the event-bridge test) to its path, or install one into
Playwright's cache. CI installs `chrome-headless-shell` with
`@puppeteer/browsers` and runs both runners on Ubuntu. `test/hygiene.test.mjs`
fails the build if a tracked file contains an absolute home path, a personal
address or a private host.

## Credits

The design follows [Jun's article](https://x.com/hyojun_at/article/2070234507995910413)
on the harness behind [Aside](https://aside.com). Go read it; then go try Aside.

## License

[MIT](LICENSE). Copyright (c) 2026 Yeongyu Kim.
