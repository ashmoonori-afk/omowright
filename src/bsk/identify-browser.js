import { NON_CHROMIUM_DEFAULTS } from "./browsers.js";

export const RECENT_USE_MS = 7 * 24 * 60 * 60 * 1000;

// BrowserSkill's extension derives browser_name from the user agent (detectBrowserMeta in
// Tencent/BrowserSkill apps/extension/src/transport/handshake.ts). Only a user-agent token names one
// browser; forks such as Brave and Arc normally keep Chrome's user agent and report "chrome", so
// "chrome"/"chromium" count only when exactly one browser able to send them is running.
const OWN_TOKEN_NAMES = new Set(["edge", "opera", "brave", "arc"]);
const FAMILY_NAMES = new Set(["chrome", "chromium"]);
const ALWAYS_SEND_OWN_TOKEN = new Set(["edge", "opera"]);

function sentBy(name, candidates) {
  if (OWN_TOKEN_NAMES.has(name)) return candidates.filter((c) => c.id === name);
  if (!FAMILY_NAMES.has(name)) return [];
  const running = candidates.filter((c) => !ALWAYS_SEND_OWN_TOKEN.has(c.id) && c.running === true);
  return running.length === 1 ? running : [];
}

function matchesDefault(browser, defaultId) {
  if (!defaultId) return false;
  return browser.defaultIds.some((id) => defaultId === id || defaultId.startsWith(id));
}

function describeDefault(defaultId, catalog) {
  if (defaultId === null || defaultId === undefined) return { raw: null, id: null, label: null, supported: null };
  const hit = catalog.find((b) => matchesDefault(b, defaultId));
  if (hit) return { raw: defaultId, id: hit.id, label: hit.label, supported: true };
  const other = NON_CHROMIUM_DEFAULTS.find((b) => b.match.some((m) => defaultId === m || defaultId.startsWith(m)));
  return other ? { raw: defaultId, id: other.id, label: other.label, supported: false } : { raw: defaultId, id: null, label: defaultId, supported: false };
}

function candidateRow(browser, { defaultBrowser, running, lastUsed }, now) {
  const isDefault = defaultBrowser.id === browser.id;
  const isRunning = Array.isArray(running) ? browser.processNames.some((n) => running.includes(n) || running.includes(n.toLowerCase())) : null;
  const last = lastUsed?.[browser.id] ?? null;
  const recentlyUsed = last !== null && now - last <= RECENT_USE_MS;
  const signals = [isDefault && "default browser", isRunning && "running now", recentlyUsed && "used in the last 7 days"].filter(Boolean);
  return { id: browser.id, label: browser.label, installed: browser.installed, isDefault, running: isRunning, lastUsedAt: last === null ? null : new Date(last).toISOString(), recentlyUsed, signals, browser };
}

function choose(candidates, primary, confidence, reason, defaultBrowser) {
  return { primary: primary.browser, primaryId: primary.id, confidence, needsChoice: false, reason, defaultBrowser, candidates: candidates.map(({ browser, ...row }) => row) };
}

function ask(candidates, reason, defaultBrowser, suggested = null) {
  return { primary: null, primaryId: null, confidence: null, needsChoice: true, reason, suggested, defaultBrowser, candidates: candidates.map(({ browser, ...row }) => row) };
}

// Picks the one Chromium browser the user actually uses, or refuses to pick. Order of authority: an
// explicit choice, the one browser whose BrowserSkill extension is connected to the daemon, the OS
// default browser when it is also in use (or nothing else is), a single browser that is the only one
// in use. Anything else — a default the user is not using while another browser runs, a Safari/Firefox
// default, several browsers in use — is a question for the user.
export function identifyBrowser({ catalog, signals = {}, explicit = null, connected = [], now = Date.now() }) {
  const defaultBrowser = describeDefault(signals.defaultBrowser ?? null, catalog);
  const installed = catalog.filter((b) => b.installed || b.id === explicit);
  const candidates = installed.map((b) => candidateRow(b, { defaultBrowser, running: signals.running ?? null, lastUsed: signals.lastUsed }, now));

  if (explicit) {
    const hit = candidates.find((c) => c.id === explicit);
    if (hit) return choose(candidates, hit, "explicit", `${hit.label} was chosen explicitly`, defaultBrowser);
    return ask(candidates, `"${explicit}" is not a Chromium-family browser this library knows; pick one of the candidates`, defaultBrowser);
  }
  if (candidates.length === 0) return ask(candidates, "no Chromium-family browser is installed", defaultBrowser);

  const attached = [...new Set(connected.flatMap((name) => sentBy(name, candidates)))];
  if (attached.length === 1) return choose(candidates, attached[0], "connected", `${attached[0].label} has the BrowserSkill extension connected`, defaultBrowser);

  const inUse = candidates.filter((c) => c.running || c.recentlyUsed);
  const def = candidates.find((c) => c.isDefault);
  if (def && (def.running || def.recentlyUsed)) return choose(candidates, def, "default-and-in-use", `${def.label} is the default browser and ${def.signals.slice(1).join(", ")}`, defaultBrowser);
  if (def && inUse.length === 0) return choose(candidates, def, "default", `${def.label} is the default browser`, defaultBrowser);
  if (def) return ask(candidates, `${def.label} is the default browser, but ${inUse.map((c) => c.label).join(" and ")} ${inUse.length === 1 ? "is" : "are"} the one in use`, defaultBrowser);

  if (defaultBrowser.supported === false) {
    const suggested = inUse.length === 1 ? inUse[0].id : null;
    return ask(candidates, `the default browser is ${defaultBrowser.label}, which BrowserSkill cannot drive; the user has to name the Chromium browser to use`, defaultBrowser, suggested);
  }
  const runningNow = inUse.filter((c) => c.running);
  if (inUse.length === 1) return choose(candidates, inUse[0], "only-in-use", `${inUse[0].label} is the only browser ${inUse[0].signals.join(", ")}`, defaultBrowser);
  if (runningNow.length === 1) return choose(candidates, runningNow[0], "only-running", `${runningNow[0].label} is the only browser running now`, defaultBrowser);
  if (inUse.length === 0 && candidates.length === 1) return choose(candidates, candidates[0], "only-installed", `${candidates[0].label} is the only Chromium-family browser installed`, defaultBrowser);
  return ask(candidates, inUse.length > 1 ? `several browsers are in use (${inUse.map((c) => c.label).join(", ")})` : "no browser shows recent use", defaultBrowser);
}
