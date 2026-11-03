// Find a Chromium browser the user already runs with remote debugging turned on
// (chrome://inspect/#remote-debugging on Chrome 144+, or --remote-debugging-port)
// and attach to it over CDP, without a browser extension in the way.
// Idea adapted from vercel-labs/agent-browser (Apache-2.0), cli/src/native/cdp/chrome.rs
// `auto_connect_cdp`: read DevToolsActivePort and use its exact WebSocket path, which
// asks the user once instead of once per discovery probe. Written fresh for this file.
import { readFile } from "node:fs/promises";
import { connect as connectTcp } from "node:net";
import path from "node:path";
import { catalogBrowsers } from "./bsk/browsers.js";
import { connect } from "./connection.js";

const DEFAULT_PORT_CHECK_MS = 1_000;

export class RunningBrowserError extends Error {
  constructor(code, message, candidates = []) {
    super(message);
    this.name = "RunningBrowserError";
    this.code = code;
    this.candidates = candidates;
  }
}

export async function readDevToolsActivePort(userDataDir) {
  const text = await readFile(path.join(userDataDir, "DevToolsActivePort"), "utf8").catch(() => null);
  if (text === null) return null;
  const [portLine, wsPath = ""] = text.split(/\r?\n/);
  const port = Number(portLine.trim());
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  const pathPart = wsPath.trim();
  return { port, wsPath: pathPart.startsWith("/devtools/browser") ? pathPart : null };
}

// A bare TCP connect: it tells a live port from a stale file without opening a
// WebSocket, so it never raises Chrome's "Allow remote debugging?" prompt.
function portIsListening(port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = connectTcp({ host: "127.0.0.1", port });
    const done = (live) => {
      socket.destroy();
      resolve(live);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function candidateDirs({ browser, userDataDirs, catalog }) {
  if (userDataDirs) return userDataDirs.map((dir) => ({ id: path.basename(dir), label: dir, userDataDir: dir }));
  const rows = catalog().filter((row) => row.hasProfile);
  return browser ? rows.filter((row) => row.id === browser) : rows;
}

// Never deletes or edits anything in the profile: a stale DevToolsActivePort is skipped,
// because the user-data folder is the user's real browser profile.
export async function findRunningBrowser({ browser, userDataDirs, portCheckMs = DEFAULT_PORT_CHECK_MS, catalog = catalogBrowsers } = {}) {
  const live = [];
  for (const candidate of candidateDirs({ browser, userDataDirs, catalog })) {
    const active = await readDevToolsActivePort(candidate.userDataDir);
    if (!active || !active.wsPath) continue;
    if (!(await portIsListening(active.port, portCheckMs))) continue;
    live.push({ ...candidate, port: active.port, wsUrl: `ws://127.0.0.1:${active.port}${active.wsPath}` });
  }
  if (live.length === 1) return live[0];
  if (live.length === 0) {
    throw new RunningBrowserError(
      "not_found",
      "No running browser has remote debugging on. Ask the user to open chrome://inspect/#remote-debugging and allow it, then retry.",
    );
  }
  throw new RunningBrowserError(
    "choose_browser",
    `More than one browser has remote debugging on (${live.map((row) => row.id).join(", ")}); pass { browser: "<id>" }.`,
    live,
  );
}

// Chrome holds the WebSocket handshake while it asks the user, so this call waits until
// the user allows or denies the prompt; one shared connection per browser keeps it to one prompt.
export async function connectRunningBrowser(options = {}) {
  const found = await findRunningBrowser(options);
  const browser = await connect(found.wsUrl, options.connect ?? {});
  return { browser, found };
}
