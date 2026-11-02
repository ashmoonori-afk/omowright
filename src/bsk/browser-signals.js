import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathFor } from "./browsers.js";

const PROBE_TIMEOUT_MS = 3_000;

function runDefault(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? null : String(stdout));
    });
  });
}

export function parseMacDefaultBrowser(plistJson) {
  let handlers;
  try { handlers = JSON.parse(plistJson)?.LSHandlers; } catch { return null; }
  if (!Array.isArray(handlers)) return null;
  const pick = (scheme) => handlers.find((h) => h?.LSHandlerURLScheme === scheme && typeof h.LSHandlerRoleAll === "string");
  const handler = pick("https") ?? pick("http");
  return handler ? handler.LSHandlerRoleAll.toLowerCase() : "com.apple.safari";
}

export function parseWindowsProgId(regOutput) {
  const match = /ProgId\s+REG_SZ\s+(\S+)/i.exec(regOutput ?? "");
  return match ? match[1].toLowerCase() : null;
}

export function parseProcessNames(platform, output) {
  const names = new Set();
  for (const raw of String(output ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (platform === "win32") {
      const image = /^"([^"]+)"/.exec(line)?.[1];
      if (image) names.add(image.toLowerCase());
    } else if (platform === "darwin") {
      if (/\.app\/Contents\/MacOS\/[^/]+$/.test(line)) names.add(line);
    } else {
      names.add(path.posix.basename(line));
    }
  }
  return [...names];
}

async function probeDefault({ platform, home, run }) {
  if (platform === "darwin") {
    const plist = path.posix.join(home, "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist");
    const json = await run("plutil", ["-convert", "json", "-o", "-", plist]);
    return json === null ? null : parseMacDefaultBrowser(json);
  }
  if (platform === "linux") {
    const out = await run("xdg-settings", ["get", "default-web-browser"]);
    return out?.trim() ? out.trim().toLowerCase() : null;
  }
  if (platform === "win32") {
    const key = "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice";
    return parseWindowsProgId(await run("reg", ["query", key, "/v", "ProgId"]));
  }
  return null;
}

async function probeRunning({ platform, run }) {
  const out = platform === "win32"
    ? await run("tasklist", ["/fo", "csv", "/nh"])
    : await run("ps", platform === "darwin" ? ["-axo", "comm="] : ["-eo", "comm="]);
  return out === null ? null : parseProcessNames(platform, out);
}

function lastUsedAt(browser, stat, { join }) {
  let latest = null;
  for (const rel of [["Local State"], ["Default", "History"], ["Default", "Preferences"]]) {
    try {
      const mtime = stat(join(browser.userDataDir, ...rel)).mtimeMs;
      if (latest === null || mtime > latest) latest = mtime;
    } catch {}
  }
  return latest;
}

// Reads the machine-wide facts that say which browser the user actually uses. Every probe degrades to
// null (unknown) instead of throwing, so a locked-down machine yields "ask the user", never a guess.
export async function probeBrowserSignals({ platform = process.platform, home = homedir(), browsers = [], run = runDefault, stat = statSync } = {}) {
  const [defaultBrowser, running] = await Promise.all([probeDefault({ platform, home, run }), probeRunning({ platform, run })]);
  const lastUsed = Object.fromEntries(browsers.map((b) => [b.id, lastUsedAt(b, stat, pathFor(platform))]));
  return { defaultBrowser, running, lastUsed };
}
