import { BskIpcClient, BskRpcError } from "./ipc-client.js";
import { BskSession } from "./session.js";
import { compact } from "./targets.js";

const DEFAULT_WAIT_FOR_BROWSER_MS = 15_000;

export async function listBrowsers(client, { waitForBrowserMs } = {}) {
  const status = await client.call("system.status", compact({ wait_for_browser_ms: waitForBrowserMs }), { idPrefix: "status" });
  return status.browsers ?? [];
}

// session.start matches only an instance id or a unique label; a browser name such as "chrome"
// (what bskDoctor reports) maps to the one connected browser with that name.
function resolveBrowser(browser, browsers) {
  if (browser === undefined || browser === null) return browser;
  if (browsers.some((b) => b.instance_id === browser || (b.label && b.label === browser))) return browser;
  const named = browsers.filter((b) => b.browser_name === browser);
  if (named.length > 1) {
    throw new BskRpcError("invalid_params", `browser "${browser}" matches ${named.length} connected browsers (${named.map((b) => b.instance_id).join(", ")}); pass the instance id instead`);
  }
  return named.length === 1 ? named[0].instance_id : browser;
}

export async function connectBrowserSkill({
  client, home, env, sockPath, autoStart, timeoutMs, bskBin,
  name, browser, width, height, focused = false,
  waitForBrowserMs = DEFAULT_WAIT_FOR_BROWSER_MS,
} = {}) {
  const ipc = client ?? new BskIpcClient({ home, env, sockPath, autoStart, timeoutMs, bskBin });
  const browsers = await listBrowsers(ipc, { waitForBrowserMs });
  if (browsers.length === 0) {
    throw new BskRpcError("no_browser_connected", "the BrowserSkill daemon is up but no browser extension is connected; open the browser that has the BrowserSkill extension enabled (bskDoctor() explains the remaining step) instead of falling back to a headless browser");
  }
  const started = await ipc.call("session.start", compact({
    task_name: name,
    browser_instance_id: resolveBrowser(browser, browsers),
    width, height, focused,
  }), { idPrefix: "session-start" });
  return new BskSession(ipc, {
    sessionId: started.session_id,
    browserInstanceId: started.browser_instance_id ?? null,
    agentWindowId: started.agent_window_id ?? null,
    interaction: started.interaction ?? null,
  });
}
