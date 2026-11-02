import { homedir } from "node:os";
import { findBskBinary } from "./daemon-info.js";
import { BskIpcClient } from "./ipc-client.js";
import { listBrowsers } from "./connect.js";
import { catalogBrowsers, externalExtensionEntry, registerExternalExtension, STORE_PAGE_URLS } from "./external-extension.js";
import { probeBrowserSignals } from "./browser-signals.js";
import { identifyBrowser } from "./identify-browser.js";
import { existsSync, readFileSync } from "node:fs";
import { cliVersionDefault, installBskCli } from "./install-cli.js";

const DEFAULT_WAIT_TOTAL_MS = 180_000;

function resolveBskBin(bskBin, env) {
  if (bskBin === null) return null;
  return bskBin ?? findBskBinary(env);
}

async function cliReport({ bskBin, env, cliVersion }) {
  const bin = resolveBskBin(bskBin, env);
  if (!bin) return { installed: false, bskBin: null, version: null };
  const raw = await cliVersion(bin);
  return raw ? { installed: true, bskBin: bin, version: raw.replace(/^bsk\s+/, "") } : { installed: false, bskBin: bin, version: null };
}

async function daemonReport(client, waitForBrowserMs) {
  try {
    const status = await client.call("system.status", waitForBrowserMs > 0 ? { wait_for_browser_ms: waitForBrowserMs } : {}, { idPrefix: "status" });
    return { running: true, version: status.daemon_version, protocolVersion: status.protocol_version, browsers: status.browsers ?? [], sessions: status.sessions ?? [] };
  } catch (error) {
    return { running: false, error: error.message, code: error.code, browsers: [], sessions: [] };
  }
}

const NO_BROWSER_STEP = `No Chromium-family browser was found. Install one (Chrome, Edge, Brave, Arc, ...), then add the extension from ${STORE_PAGE_URLS.chrome}.`;

function withRegistration(platform, browser) {
  const entry = externalExtensionEntry({ platform, browser });
  const extensionRegistered = entry.kind === "file" && existsSync(entry.path) && readFileSync(entry.path, "utf8") === entry.content;
  return { ...browser, registration: entry, extensionRegistered };
}

async function identify({ platform, home, env, exists, browser, signals, probeSignals, now }) {
  const catalog = catalogBrowsers({ platform, home, env, exists }).map((b) => withRegistration(platform, b));
  const observed = signals ?? await probeSignals({ platform, home, browsers: catalog.filter((b) => b.hasProfile) });
  const explicit = browser ?? env.OMOWRIGHT_BROWSER ?? null;
  const { primary, ...identification } = identifyBrowser({ catalog, signals: observed, explicit: explicit || null, now });
  const browsers = catalog.filter((b) => b.installed);
  const registeredElsewhere = browsers.filter((b) => b.extensionRegistered && b.id !== identification.primaryId).map((b) => b.id);
  return { browsers, identification: { ...identification, registeredElsewhere }, primary };
}

function choiceStep(identification) {
  const listed = identification.candidates.map((c) => `${c.label} [${c.id}]${c.signals.length ? ` — ${c.signals.join(", ")}` : ""}`).join("; ");
  const hint = identification.suggested ? ` Likely ${identification.suggested}, but confirm first.` : "";
  return `Ask the user which browser they actually use (${identification.reason}). Candidates: ${listed}.${hint} Then re-run with browser: "<id>"; register nothing until they answer.`;
}

function nextStepFor({ cli, daemon, browsers, browsersConnected, identification, primary }) {
  if (browsersConnected.length > 0) return null;
  if (!cli.installed) return "Install the bsk CLI (bskOnboard() runs the official installer).";
  if (!daemon.running) return "Start the BrowserSkill daemon: run `bsk status` once, or `bsk daemon start` in the environment that owns it.";
  if (browsers.length === 0 && !primary) return NO_BROWSER_STEP;
  if (identification.needsChoice) return choiceStep(identification);
  if (!primary.extensionRegistered && primary.registration.kind !== "store") return `Register the BrowserSkill extension for ${primary.label} (bskOnboard() does this), then let the user enable it.`;
  return primary.registration.humanStep;
}

export async function bskDoctor({
  platform = process.platform, home = homedir(), env = process.env, client, bskBin, cliVersion = cliVersionDefault, waitForBrowserMs = 0,
  exists = existsSync, browser, signals, probeSignals = probeBrowserSignals, now = Date.now(),
} = {}) {
  const cli = await cliReport({ bskBin, env, cliVersion });
  const ipc = client ?? new BskIpcClient({ env, bskBin: cli.bskBin ?? undefined, autoStart: false });
  const daemon = await daemonReport(ipc, waitForBrowserMs);
  const { browsers, identification, primary } = await identify({ platform, home, env, exists, browser, signals, probeSignals, now });
  const browsersConnected = daemon.browsers;
  const report = { cli, daemon, browsers, primary: primary ?? null, identification, browsersConnected, ready: browsersConnected.length > 0 };
  report.nextStep = nextStepFor(report);
  return report;
}

export async function bskOnboard({
  platform = process.platform, home = homedir(), env = process.env, client, bskBin, installDir,
  installCli = installBskCli, cliVersion = cliVersionDefault, onHumanStep = () => {},
  waitForBrowserMs = 15_000, waitTotalMs = DEFAULT_WAIT_TOTAL_MS,
  exists = existsSync, browser, signals, probeSignals = probeBrowserSignals, now = Date.now(),
} = {}) {
  let cli = await cliReport({ bskBin, env, cliVersion });
  let install = null;
  if (!cli.installed) {
    install = await installCli({ platform, home, installDir });
    cli = install.installed ? await cliReport({ bskBin: install.bskBin, env, cliVersion }) : cli;
  }
  const ipc = client ?? new BskIpcClient({ env, bskBin: cli.bskBin ?? undefined, autoStart: true });
  let daemon = await daemonReport(ipc, 0);
  const { browsers, identification, primary } = await identify({ platform, home, env, exists, browser, signals, probeSignals, now });
  const registrations = [];
  let humanStep = null;
  let needsChoice = false;
  if (daemon.browsers.length === 0) {
    if (browsers.length === 0 && !primary) {
      humanStep = NO_BROWSER_STEP;
    } else if (identification.needsChoice) {
      needsChoice = true;
      humanStep = choiceStep(identification);
    } else if (daemon.running) {
      // A down daemon hides whether the extension is already enabled, so no step goes to the user until it is up.
      const registration = await registerExternalExtension({ platform, browser: primary });
      registrations.push({ browser: primary.id, ...registration });
      humanStep = registration.humanStep;
      onHumanStep({ browser: primary.id, step: registration.humanStep, registered: registration.registered, needsRestart: registration.needsRestart });
    }
  }
  const deadline = Date.now() + waitTotalMs;
  let browsersConnected = daemon.browsers;
  while (!needsChoice && browsersConnected.length === 0 && daemon.running && Date.now() < deadline) {
    browsersConnected = await listBrowsers(ipc, { waitForBrowserMs });
    if (waitForBrowserMs === 0) break;
  }
  daemon = { ...daemon, browsers: browsersConnected };
  const ready = browsersConnected.length > 0;
  const nextStep = ready ? null : humanStep ?? nextStepFor({ cli, daemon, browsers, browsersConnected, identification, primary });
  return { cli, install, daemon, browsers, primary: primary ?? null, identification, needsChoice, registrations, humanStep: ready ? null : humanStep, nextStep, browsersConnected, ready };
}
