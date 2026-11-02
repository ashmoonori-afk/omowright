import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const BROWSERSKILL_EXTENSION_IDS = Object.freeze({
  chrome: "hhcmgoofomhgciiibhipgmgkgnoenaoi",
  edge: "emacgiaaaiojkkpkddmmdfhmokgmnikg",
});

export const STORE_UPDATE_URLS = Object.freeze({
  chrome: "https://clients2.google.com/service/update2/crx",
  edge: "https://edge.microsoft.com/extensionwebstorebase/v1/crx",
});

export const STORE_PAGE_URLS = Object.freeze({
  chrome: `https://chromewebstore.google.com/detail/${BROWSERSKILL_EXTENSION_IDS.chrome}`,
  edge: `https://microsoftedge.microsoft.com/addons/detail/browserskill/${BROWSERSKILL_EXTENSION_IDS.edge}`,
});

export const NON_CHROMIUM_DEFAULTS = Object.freeze([
  { id: "safari", label: "Safari", match: ["com.apple.safari", "safarihtml"] },
  { id: "firefox", label: "Firefox", match: ["org.mozilla.firefox", "firefox.desktop", "firefoxurl", "firefoxhtml"] },
  { id: "zen", label: "Zen", match: ["app.zen-browser.zen", "zen.desktop", "zenhtml"] },
  { id: "orion", label: "Orion", match: ["com.kagi.kagimacos"] },
]);

// externalExtensions: false marks a browser whose external-extension path is unknown or not honoured;
// onboarding hands the user that browser's store link instead of writing a file nobody reads.
const MAC = [
  { id: "chrome", label: "Google Chrome", store: "chrome", userData: "Library/Application Support/Google/Chrome", app: "Google Chrome", bundleId: "com.google.Chrome" },
  { id: "edge", label: "Microsoft Edge", store: "edge", userData: "Library/Application Support/Microsoft Edge", app: "Microsoft Edge", bundleId: "com.microsoft.edgemac" },
  { id: "brave", label: "Brave", store: "chrome", userData: "Library/Application Support/BraveSoftware/Brave-Browser", app: "Brave Browser", bundleId: "com.brave.Browser" },
  { id: "chromium", label: "Chromium", store: "chrome", userData: "Library/Application Support/Chromium", app: "Chromium", bundleId: "org.chromium.Chromium" },
  { id: "arc", label: "Arc", store: "chrome", userData: "Library/Application Support/Arc/User Data", app: "Arc", bundleId: "company.thebrowser.Browser" },
  { id: "dia", label: "Dia", store: "chrome", userData: "Library/Application Support/Dia/User Data", app: "Dia", bundleId: "company.thebrowser.dia" },
  { id: "vivaldi", label: "Vivaldi", store: "chrome", userData: "Library/Application Support/Vivaldi", app: "Vivaldi", bundleId: "com.vivaldi.Vivaldi" },
  { id: "opera", label: "Opera", store: "chrome", userData: "Library/Application Support/com.operasoftware.Opera", app: "Opera", bundleId: "com.operasoftware.Opera", externalExtensions: false },
  { id: "comet", label: "Comet", store: "chrome", userData: "Library/Application Support/Comet", app: "Comet", bundleId: "ai.perplexity.comet" },
  { id: "aside", label: "Aside", store: "chrome", userData: "Library/Application Support/Aside", app: "Aside", bundleId: "at.studio.AsideBrowser" },
  { id: "whale", label: "Naver Whale", store: "chrome", userData: "Library/Application Support/Naver/Whale", app: "Naver Whale", bundleId: "com.naver.Whale" },
];

const LINUX = [
  { id: "chrome", label: "Google Chrome", store: "chrome", userData: ".config/google-chrome", binaries: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"], externalDir: "/opt/google/chrome/extensions", userExternalDir: false, desktopIds: ["google-chrome.desktop", "google-chrome-stable.desktop", "com.google.Chrome.desktop"], processNames: ["chrome", "google-chrome"] },
  { id: "chromium", label: "Chromium", store: "chrome", userData: ".config/chromium", binaries: ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"], externalDir: "/usr/share/chromium/extensions", userExternalDir: true, desktopIds: ["chromium.desktop", "chromium-browser.desktop", "chromium_chromium.desktop", "org.chromium.Chromium.desktop"], processNames: ["chromium", "chromium-browse"] },
  { id: "edge", label: "Microsoft Edge", store: "edge", userData: ".config/microsoft-edge", binaries: ["/usr/bin/microsoft-edge", "/opt/microsoft/msedge/msedge"], externalDir: "/usr/share/microsoft-edge/extensions", userExternalDir: false, desktopIds: ["microsoft-edge.desktop", "microsoft-edge-stable.desktop", "com.microsoft.Edge.desktop"], processNames: ["msedge"] },
  { id: "brave", label: "Brave", store: "chrome", userData: ".config/BraveSoftware/Brave-Browser", binaries: ["/usr/bin/brave-browser", "/opt/brave.com/brave/brave"], externalDir: "/usr/share/brave/extensions", userExternalDir: false, desktopIds: ["brave-browser.desktop", "com.brave.Browser.desktop"], processNames: ["brave"] },
  { id: "vivaldi", label: "Vivaldi", store: "chrome", userData: ".config/vivaldi", binaries: ["/usr/bin/vivaldi", "/opt/vivaldi/vivaldi"], externalDir: null, userExternalDir: false, externalExtensions: false, desktopIds: ["vivaldi-stable.desktop", "vivaldi.desktop"], processNames: ["vivaldi-bin"] },
  { id: "opera", label: "Opera", store: "chrome", userData: ".config/opera", binaries: ["/usr/bin/opera"], externalDir: null, userExternalDir: false, externalExtensions: false, desktopIds: ["opera.desktop"], processNames: ["opera"] },
];

const WINDOWS = [
  { id: "chrome", label: "Google Chrome", store: "chrome", userData: "Google/Chrome/User Data", registryKey: "HKCU\\Software\\Google\\Chrome\\Extensions", binaryRel: "Google/Chrome/Application/chrome.exe", progIds: ["chromehtml"], processNames: ["chrome.exe"] },
  { id: "edge", label: "Microsoft Edge", store: "edge", userData: "Microsoft/Edge/User Data", registryKey: "HKCU\\Software\\Microsoft\\Edge\\Extensions", binaryRel: "Microsoft/Edge/Application/msedge.exe", progIds: ["msedgehtm"], processNames: ["msedge.exe"] },
  { id: "brave", label: "Brave", store: "chrome", userData: "BraveSoftware/Brave-Browser/User Data", registryKey: "HKCU\\Software\\BraveSoftware\\Brave-Browser\\Extensions", binaryRel: "BraveSoftware/Brave-Browser/Application/brave.exe", progIds: ["bravehtml"], processNames: ["brave.exe"] },
  { id: "chromium", label: "Chromium", store: "chrome", userData: "Chromium/User Data", registryKey: "HKCU\\Software\\Chromium\\Extensions", binaryRel: "Chromium/Application/chrome.exe", progIds: ["chromiumhtm"], processNames: [] },
  { id: "vivaldi", label: "Vivaldi", store: "chrome", userData: "Vivaldi/User Data", registryKey: null, externalExtensions: false, binaryRel: "Vivaldi/Application/vivaldi.exe", progIds: ["vivaldihtm"], processNames: ["vivaldi.exe"] },
  { id: "whale", label: "Naver Whale", store: "chrome", userData: "Naver/Naver Whale/User Data", registryKey: null, externalExtensions: false, binaryRel: "Naver/Naver Whale/Application/whale.exe", progIds: ["whalehtml"], processNames: ["whale.exe"] },
];

export const BROWSER_IDS = Object.freeze([...new Set([...MAC, ...LINUX, ...WINDOWS].map((b) => b.id))]);

// Paths are built for the TARGET platform, not the host: a darwin/linux row is the same on every host.
export const pathFor = (platform) => (platform === "win32" ? path.win32 : path.posix);

function macRow(b, home, exists) {
  const { join } = path.posix;
  const apps = [join("/Applications", `${b.app}.app`), join(home, "Applications", `${b.app}.app`)];
  const appPath = apps.find((p) => exists(p)) ?? null;
  const userDataDir = join(home, b.userData);
  return {
    id: b.id, label: b.label, store: b.store, userDataDir,
    binary: join(appPath ?? apps[0], "Contents", "MacOS", b.app), bundleId: b.bundleId,
    processNames: apps.map((a) => join(a, "Contents", "MacOS", b.app)), defaultIds: [b.bundleId.toLowerCase()], externalExtensions: b.externalExtensions !== false,
    installed: appPath !== null || exists(userDataDir), hasProfile: exists(userDataDir),
  };
}

function linuxRow(b, home, exists) {
  const userDataDir = path.posix.join(home, b.userData);
  const binary = b.binaries.find((p) => exists(p)) ?? null;
  return {
    id: b.id, label: b.label, store: b.store, userDataDir, binary,
    externalDir: b.externalDir, userExternalDir: b.userExternalDir,
    processNames: b.processNames, defaultIds: b.desktopIds.map((d) => d.toLowerCase()), externalExtensions: b.externalExtensions !== false,
    installed: binary !== null || exists(userDataDir), hasProfile: exists(userDataDir),
  };
}

function windowsRow(b, env, home, exists) {
  const { join } = path.win32;
  const localAppData = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  const programFiles = [localAppData, env.PROGRAMFILES, env["PROGRAMFILES(X86)"], "C:\\Program Files", "C:\\Program Files (x86)"].filter(Boolean);
  const userDataDir = join(localAppData, b.userData);
  const binary = programFiles.map((root) => join(root, b.binaryRel)).find((p) => exists(p)) ?? null;
  return {
    id: b.id, label: b.label, store: b.store, userDataDir, registryKey: b.registryKey, binary,
    processNames: b.processNames, defaultIds: b.progIds, externalExtensions: b.externalExtensions !== false,
    installed: binary !== null || exists(userDataDir), hasProfile: exists(userDataDir),
  };
}

// Every catalog browser for the platform with installed/hasProfile flags; `detectBrowsers` keeps the
// installed ones. Being installed says nothing about use — `identifyBrowser` ranks by usage signals.
export function catalogBrowsers({ platform = process.platform, home = homedir(), env = process.env, exists = existsSync } = {}) {
  if (platform === "darwin") return MAC.map((b) => macRow(b, home, exists));
  if (platform === "linux") return LINUX.map((b) => linuxRow(b, home, exists));
  if (platform === "win32") return WINDOWS.map((b) => windowsRow(b, env, home, exists));
  return [];
}

export function detectBrowsers(options = {}) {
  return catalogBrowsers(options).filter((b) => b.installed);
}
