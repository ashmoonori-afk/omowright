// Registers the Web Store extension through Chrome's "external extensions"
// mechanism (the only non-enterprise path that survives Chrome 25's ban on
// silent installs): a per-user JSON file on macOS/Chromium-Linux, an HKCU
// registry value on Windows, a root-owned directory for Google Chrome on
// Linux. Windows and macOS still show one "Enable extension?" prompt.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { windowsSystemTool } from "../owner-only.js";
import { BROWSERSKILL_EXTENSION_IDS, STORE_PAGE_URLS, STORE_UPDATE_URLS, pathFor } from "./browsers.js";

export { BROWSERSKILL_EXTENSION_IDS, STORE_PAGE_URLS, STORE_UPDATE_URLS, catalogBrowsers, detectBrowsers } from "./browsers.js";

const ENABLE_STEP = (browser) => `Quit ${browser} completely and open it again; a dialog offers to enable "BrowserSkill" — click Enable.`;
const BADGE_STEP = (browser) => `In ${browser}, open the menu (the badge on the toolbar) and enable "BrowserSkill" when prompted; no restart is needed.`;

const storeStep = (browser, label) => `Open ${STORE_PAGE_URLS[browser.store]} in ${label} and click the "Add" button.`;

export function externalExtensionEntry({ platform = process.platform, browser }) {
  const id = BROWSERSKILL_EXTENSION_IDS[browser.store];
  const updateUrl = STORE_UPDATE_URLS[browser.store];
  const label = browser.label ?? browser.id.charAt(0).toUpperCase() + browser.id.slice(1);
  if (browser.externalExtensions === false) {
    return { kind: "store", needsRestart: false, storeUrl: STORE_PAGE_URLS[browser.store], humanStep: storeStep(browser, label) };
  }
  if (platform === "win32") {
    const key = `${browser.registryKey}\\${id}`;
    return {
      kind: "registry", key, needsRestart: false, storeUrl: STORE_PAGE_URLS[browser.store],
      regAddArgs: ["add", key, "/v", "update_url", "/t", "REG_SZ", "/d", updateUrl, "/f"],
      regDeleteArgs: ["delete", key, "/f"],
      humanStep: BADGE_STEP(label),
    };
  }
  const content = JSON.stringify({ external_update_url: updateUrl }, null, 2) + "\n";
  if (platform === "linux" && !browser.userExternalDir) {
    return {
      kind: "file", path: pathFor(platform).join(browser.externalDir, `${id}.json`), content, needsRestart: true,
      storeUrl: STORE_PAGE_URLS[browser.store],
      humanStep: `Quit ${label} completely and open it again; the extension installs without a prompt.`,
    };
  }
  return {
    kind: "file", path: pathFor(platform).join(browser.userDataDir, "External Extensions", `${id}.json`), content, needsRestart: true,
    storeUrl: STORE_PAGE_URLS[browser.store],
    humanStep: platform === "linux" ? `Quit ${label} completely and open it again; the extension installs without a prompt.` : ENABLE_STEP(label),
  };
}

export function isBlocklisted(browser, id, { readFile = readFileSync } = {}) {
  if (!browser.userDataDir) return false;
  for (const profile of ["Default", "Profile 1", "Profile 2", "Profile 3"]) {
    const file = path.join(browser.userDataDir, profile, "Preferences");
    let prefs;
    try { prefs = JSON.parse(readFile(file, "utf8")); } catch { continue; }
    if (Array.isArray(prefs?.extensions?.external_uninstalls) && prefs.extensions.external_uninstalls.includes(id)) return true;
  }
  return false;
}

function runRegDefault(args) {
  return new Promise((resolve) => {
    const child = spawn(windowsSystemTool("reg.exe"), args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", (error) => resolve({ code: -1, stderr: error.message }));
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}

export async function registerExternalExtension({ platform = process.platform, browser, writeFile = writeFileSync, readFile = readFileSync, runReg = runRegDefault } = {}) {
  const entry = externalExtensionEntry({ platform, browser });
  const id = BROWSERSKILL_EXTENSION_IDS[browser.store];
  const label = browser.label ?? browser.id;
  const storeStep = `Open ${entry.storeUrl} in ${label} and click the "Add" button.`;
  if (entry.kind === "store") return { ...entry, registered: false, alreadyPresent: false, reason: "store_only" };
  if (isBlocklisted(browser, id, { readFile })) {
    return { ...entry, registered: false, alreadyPresent: false, reason: "blocklisted", humanStep: `The extension was removed from ${label} before, so external registration is ignored. ${storeStep}` };
  }
  if (entry.kind === "registry") {
    const result = await runReg(entry.regAddArgs);
    if (result.code !== 0) return { ...entry, registered: false, alreadyPresent: false, reason: "reg_failed", detail: result.stderr, humanStep: storeStep };
    return { ...entry, registered: true, alreadyPresent: false };
  }
  let alreadyPresent = false;
  try { alreadyPresent = readFile(entry.path, "utf8") === entry.content; } catch {}
  if (alreadyPresent) return { ...entry, registered: true, alreadyPresent: true };
  try {
    mkdirSync(path.dirname(entry.path), { recursive: true });
    writeFile(entry.path, entry.content);
  } catch (error) {
    if (error.code === "EACCES" || error.code === "EPERM" || error.code === "EROFS") {
      return { ...entry, registered: false, alreadyPresent: false, reason: "not_writable", humanStep: `${entry.path} is not writable without administrator rights. ${storeStep}` };
    }
    throw error;
  }
  return { ...entry, registered: true, alreadyPresent: false };
}

export async function unregisterExternalExtension({ platform = process.platform, browser, runReg = runRegDefault } = {}) {
  const entry = externalExtensionEntry({ platform, browser });
  if (entry.kind === "store") return { ...entry, removed: false };
  if (entry.kind === "registry") {
    const result = await runReg(entry.regDeleteArgs);
    return { ...entry, removed: result.code === 0, detail: result.stderr };
  }
  const present = existsSync(entry.path);
  if (present) rmSync(entry.path, { force: true });
  return { ...entry, removed: present };
}
