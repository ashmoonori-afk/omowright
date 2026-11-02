# Stealth — CloakBrowser through OmOWright

CloakBrowser is a stealth Chromium with source-level fingerprint patches (passes
Cloudflare Turnstile, FingerprintJS, BrowserScan). OmOWright drives its binary
over the pipe transport — no CDP port, no agent-browser CLI.

## Binary discovery

```bash
python3 -c "import cloakbrowser, json; print(cloakbrowser.binary_info()['binary_path'])"
# -> ~/.cloakbrowser/chromium-<ver>/Chromium.app/Contents/MacOS/Chromium
```

Not installed: `uv pip install "cloakbrowser==0.5.7"` in a venv, then
`python -c "import cloakbrowser; cloakbrowser.ensure_binary()"`.

## Single-instance rule

CloakBrowser enforces **ONE RUNNING INSTANCE** (Chromium SingletonLock, possibly
strengthened by source patches). If one is already running, `connectPipe` HANGS
during early init — the `Browser.getVersion` handshake never answers and
OmOWright times out.

Use `connectNamed(name, options)` — attach-or-launch under one name, no probe
ritual. A healthy registered instance is attached over its endpoint; a stale
record is cleaned up and the browser relaunched; a live pid whose recorded port
refuses connections, or answers as a different browser, is a reused pid (treated
as stale), while an endpoint that hangs or answers wrongly fails fast with an
`unresponsive holder` error naming the holder (name, pid, endpoint). The record
stores the browser's `webSocketDebuggerUrl` (it carries the browser GUID), and
an attach happens only when the endpoint still answers with that exact URL. The
returned `BrowserConnection` supports `newTab()` on both the launch and the
attach path.

**A named instance is not private.** Naming one replaces the pipe transport with
a TCP endpoint (`--remote-debugging-address=127.0.0.1 --remote-debugging-port=0`).
Loopback keeps it off the network, but nothing authenticates it: any process or
user on this machine can read the registry record (or scan the port) and drive
the browser — cookies, logged-in sessions, local file reads through CDP.
Name-less launches keep the pipe and expose no port at all, so use a name only
on a machine you trust and only when the instance is meant to be shared.

```js
const { connectNamed, listInstances } = await import("omowright");
const browser = await connectNamed("cloak-main", {
  browserPath,   // required only when a launch is needed (connectCloakProfile resolves it)
  browserArgs,
  profileDir,    // recorded with the instance; used for endpoint discovery
  registryRoot,  // defaults to ~/.local/share/omowright/instances
});
const page = await browser.newTab("https://target.com");
await listInstances();
// [{ name, pid, endpoint, webSocketDebuggerUrl, profileDir, browserPath,
//    startedAt, alive, responsive }]
```

`close()` on the launcher terminates the browser and removes its record; on an
attached client it only detaches — the instance keeps running for the next
`connectNamed`. Attaches in one process share one CDP connection per browser
(Chrome asks to allow remote debugging once per connection): `close()`
releases your handle and the last release disconnects, so keep one handle
open across actions instead of attaching per action.
`connectCloakProfile({ name })` and `omowright-cloak --name <name>` go through
the same registry: same name, same instance. Without `name` both keep the
zero-port pipe and never touch the registry.

**Fallback — a nameless CloakBrowser is already running** (launched outside
OmOWright): probe the legacy endpoint, then attach — do NOT spawn another.

```bash
curl -s -m 2 http://127.0.0.1:9242/json/version   # Browser info -> an instance is alive
```

```js
const browser = await connect("http://127.0.0.1:9242");
const page = await browser.newTab("https://target.com");
// ... work ...
await page.close();                               // close only YOUR tab
```

## Launch

```js
const { connectCloakProfile } = await import("omowright");
const browser = await connectCloakProfile({
  profileDir: `${process.env.HOME}/.local/share/omowright-cloak`,
  fingerprintSeed: 63498,   // first use pins it; later runs reuse it and reject a mismatch
});
```

CLI equivalent:
`omowright-cloak --profile "$HOME/.local/share/omowright-cloak" --url https://target.example --once --snapshot`

- Omit `--headless` when the WAF is aggressive — headed mode carries stronger
  trust signals. The patches apply in both modes.
- Do NOT pass an init-script for `navigator.webdriver` — CloakBrowser patches it
  at C++ source. `--user-agent` is the only override worth passing.
- The seed lives in `.omowright-cloak.json` (mode `0600`) and is passed as the
  same `--fingerprint=<seed>` on every launch. Do not pass `--user-data-dir`,
  `--fingerprint`, or `--fingerprint-platform` through `browserArgs`; conflicting
  identity overrides are rejected.
- The helper uses `connectPipe()` — `connectNamed()` when you pass `name` — so
  an anonymous launch still has no listening CDP TCP port. One process per
  profile.

Verify: `await page.evaluate("navigator.webdriver")` must be `false`. For a full
check load `https://bot.sannysoft.com` or `https://browserscan.net` and read the
result panel with a snapshot.

## Persistent profiles and cookies

Reuse a stable `--user-data-dir` (not a temp dir) to keep logins across runs —
WAF trust builds with profile age. To import cookies from a real browser profile,
extract them to JSON and inject with the package helper:

```js
import { injectCookies } from "omowright";
const cookies = JSON.parse(await fs.promises.readFile(cookieFile, "utf8"));
await injectCookies(page, cookies);   // sanitize + Network.setCookies
await page.goto(url);                 // cookies apply on navigation
```

`injectCookies` drops `expires <= 0`, forces `secure` + root path + url-scoping
for `__Host-` cookies, drops `SameSite=None` when not secure, and dedupes by
name+domain — raw exports fail CDP validation without this. Cookie files are
live secrets: `0600`, never committed, never printed.

## NEVER extract and reuse cookies for Google or 1Password

**HARD RULE, LEARNED BY KILLING THE USER'S REAL SESSIONS ON 2026-08-23. VIOLATING
IT LOGS THE USER OUT OF THEIR OWN BROWSER.**

- **Google (any property: youtube.com, google.com, accounts.google.com, mail,
  drive, ...)** — Google's risk engine detects reuse from a new device
  fingerprint and **invalidates the session server-side; the source browser is
  logged out too.** One run succeeds, then the account is signed out everywhere
  the cookies came from. Not a rotation you can race — a kill. To act as the
  user on Google, drive the user's own logged-in browser.
- **1Password web (1password.com)** — sessions are bound to full app state
  (IndexedDB device keys, SRP session derivation), not cookies. Injection always
  lands on the sign-in page, from any machine including the same one. There is
  no cookie-only path in.
- 1Password direct login does not persist across tabs either: a new tab to
  my.1password.com asks for the password again. The original logged-in tab stays
  valid — keep it open and reuse it.
- 1Password auto-lock extends to 8 hours max (Settings > Security > Auto-lock >
  8 hours), but closing the browser ALWAYS locks it — hardcoded. Keep the browser
  running and the tab open.

Cookie extraction + injection stays fine for sites with ordinary session cookies
(Grafana, internal tools, most SaaS).

## Session reuse doctrine (ordinary cookie sessions)

Do everything in ONE browser session: inject, navigate, read, screenshot, one
run. Cross-run reuse dies — Grafana rotates its session token per request, so a
reused cookie works once and re-extracting yields the same dead token. Recovery
is a fresh login in the source browser, then extract + use immediately.

## Chromium cookie decryption notes (macOS)

- Keychain `*- Safe Storage` password -> PBKDF2(`saltysalt`, 1003) ->
  AES-128-CBC with a 16-space IV; strip the `v10` prefix AND the 32-byte SHA256
  domain hash prepended to the plaintext.
- Read from a GUI login session (for example a LaunchAgent), NOT plain SSH — the keychain
  denies secret reads (`-w`) from non-GUI sessions.
- A cookie DB in rollback-journal mode (empty `-journal`) needs only the main
  `Cookies` file copied; a WAL-mode DB needs its `-wal` file copied alongside.

## When stealth is NOT needed

A plain headless shell is faster and sufficient for most sites. Reach for
CloakBrowser when the plain path returns a challenge page (Cloudflare "Verify
you are human", DataDome, PerimeterX) or empty content.
