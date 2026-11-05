# CloakBrowser persistent profiles

Use a persistent CloakBrowser profile when an automation job must keep its
browser state between runs. The profile is a normal Chromium user-data
directory owned by the machine that runs the job.

## Requirements

- Bun or Node.js 20+
- OmOWright imported from this checkout
- CloakBrowser installed locally
- A stable, private profile directory

```bash
uv venv ~/.local/share/omowright-cloak-venv
uv pip install --python ~/.local/share/omowright-cloak-venv/bin/python \
  'cloakbrowser==0.5.7'
~/.local/share/omowright-cloak-venv/bin/python -c \
  'import cloakbrowser; print(cloakbrowser.binary_info()["binary_path"])'
```

Do not assume the versioned Chromium directory. Resolve the binary path with
`cloakbrowser.binary_info()` on the machine that will run the job.

## Stable profile identity

Use the bundled `omowright-cloak` launcher when the profile will be reused for
an authenticated site. On first use it creates
`.omowright-cloak.json` inside the profile with a random fingerprint seed and
sets the file to mode `0600`. Every later run reuses that seed. Passing a
different `--seed` for an existing profile fails instead of silently changing
the browser identity.

```bash
omowright-cloak \
  --profile "$HOME/.local/share/omowright-cloak" \
  --seed 63498 \
  --url https://example.com \
  --once \
  --snapshot
```

The profile directory is mode `0700`. On Windows, where mode bits do not
restrict access, it gets a protected ACL that grants only the current user (plus
SYSTEM and Administrators, Windows' root equivalents, where Windows put them)
and that its files inherit; the metadata file gets the same. A later run that
finds the directory already protected that way leaves its ACL alone. The ACL
needs a volume that keeps ACLs: on FAT32, exFAT or a network share without them,
`connectCloakProfile()` throws rather than use a profile other users can read, so
keep the profile on an NTFS or ReFS volume. The metadata file is not a credential
store; it only pins the CloakBrowser fingerprint seed. Keep the profile on the
machine that owns the session, and never commit it.

Do not put `--user-data-dir`, `--fingerprint`, or
`--fingerprint-platform` in `browserArgs` when using `connectCloakProfile()`.
Those identity flags are generated from the profile metadata and conflicting
overrides fail closed.

## Launch and reuse one profile

```js
import { connectPipe, compactSnapshot } from
  "omowright";
import fs from "node:fs";

const profile = "/path/to/private/browser-profile";
const browserPath = "/path/to/CloakBrowser/Chromium.app/Contents/MacOS/Chromium";

fs.mkdirSync(profile, { recursive: true });

const browser = await connectPipe({
  browserPath,
  browserArgs: [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    `--user-data-dir=${profile}`,
  ],
  storageRoot: profile,
});

try {
  const page = await browser.newTab("https://example.com");
  console.log({
    url: await page.url(),
    title: await page.title(),
    snapshot: compactSnapshot(await page.snapshot({ interactive: true })),
  });
} finally {
  await browser.close();
}
```

The profile directory must remain in place after `browser.close()`. Closing the
browser releases the process; it does not delete the profile. The next run
passes the same `--user-data-dir` and reuses the state stored there.

Only one CloakBrowser process should use a given profile at a time. A stale
`SingletonLock` or a concurrently running process can make `connectPipe()` hang
or fail during startup. Use a separate profile for parallel jobs.

`connectPipe()` appends `--remote-debugging-pipe`, so this route has no
listening CDP TCP port. For a stealth profile, the launcher must also pass
CloakBrowser's `--fingerprint=<seed>` and `--fingerprint-platform=<platform>`
flags. `connectCloakProfile()` does both and is the preferred programmatic
entry point:

```js
import { connectCloakProfile } from
  "omowright";

const browser = await connectCloakProfile({
  profileDir: "/path/to/private/browser-profile",
  fingerprintSeed: 63498,
});
```

The generic `connectPipe()` example above demonstrates profile persistence, but
it does not pin a CloakBrowser identity by itself. Use
`connectCloakProfile()` or add the fixed fingerprint flags yourself when the
target's risk system is sensitive to device changes.

## Login state and cookies

Prefer logging in interactively in this same persistent profile, then reuse the
profile on later runs. A runner must detect a login page and stop with an
actionable status instead of guessing or looping.

Do **not** extract Google or 1Password cookies from another browser profile and
inject them into this profile. Google can invalidate the source session when
cookies are reused on a different device fingerprint, and 1Password sessions
depend on device-bound application state rather than cookies alone.

`injectCookies()` is available for ordinary cookie-based sites when the caller
explicitly provides an authorized export:

```js
import { injectCookies } from
  "omowright";

await injectCookies(page, authorizedCookies);
```

Never print cookies, OAuth query strings, passwords, OTPs, tokens, or snapshots
of credential fields. Keep profile directories and cookie exports mode `0700`
or `0600` and outside the repository.

## Scheduler boundary

The browser process and persistent profile belong on the machine that owns the
browser session. A scheduler should invoke the runner locally, for example
through a LaunchAgent, and should not target a browser session on another
machine.

A stateful runner should:

1. Start OmOWright with the stable CloakBrowser profile.
2. Navigate to the target and inspect the current URL and accessible snapshot.
3. Stop and report `login_required` when the profile is logged out.
4. Confirm the target's current state before mutating data.
5. Click only the intended control.
6. Verify the resulting state before exiting.

Keep the browser profile and the scheduler's logs on the same machine. Never
copy the profile to another host as a shortcut for authentication.
