import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultNativeMessagingHostDir } from "../src/bridge-transport.js";

// Chrome's documented per-user native messaging host locations.
const EXPECTED = {
  darwin: {
    chrome: ["Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts"],
    chromium: ["Library", "Application Support", "Chromium", "NativeMessagingHosts"],
  },
  linux: {
    chrome: [".config", "google-chrome", "NativeMessagingHosts"],
    chromium: [".config", "chromium", "NativeMessagingHosts"],
  },
};

for (const [platform, browsers] of Object.entries(EXPECTED)) {
  for (const [browser, segments] of Object.entries(browsers)) {
    test(`default native messaging host dir: ${browser} on ${platform}`, () => {
      assert.equal(defaultNativeMessagingHostDir(browser, platform), path.join(homedir(), ...segments));
    });
  }
}

// Windows has no directory Chrome scans (the registry value points at the manifest), so the default is a per-user
// directory under %LOCALAPPDATA%, one per browser.
test("default native messaging host dir: per-user LocalAppData directory on win32", () => {
  const localAppData = process.env.LOCALAPPDATA ?? path.win32.join(homedir(), "AppData", "Local");
  for (const browser of ["chrome", "chromium"]) {
    assert.equal(defaultNativeMessagingHostDir(browser, "win32"), path.win32.join(localAppData, "omowright", "NativeMessagingHosts", browser));
  }
});

test("default native messaging host dir refuses unknown browsers and platforms", () => {
  assert.throws(() => defaultNativeMessagingHostDir("cloakbrowser", "linux"), /custom browser requires nativeMessagingHostDir/);
  assert.throws(() => defaultNativeMessagingHostDir("cloakbrowser", "win32"), /custom browser requires nativeMessagingHostDir/);
  assert.throws(() => defaultNativeMessagingHostDir("chrome", "freebsd"), /no default nativeMessagingHostDir on freebsd/);
});
