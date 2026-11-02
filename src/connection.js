import path from "node:path";
import { mkdir } from "node:fs/promises";
import {
  CdpClient,
  FrameManager,
  OmOPage,
  SessionManager,
} from "./core.js";
import { acquireSharedConnection, canShareConnection } from "./shared-connections.js";

export class TabRepository {
  #client;
  constructor(client) { this.#client = client; }
  async listTargets() { return this.#client.discoverTargets(); }
}

export class BrowserConnection {
  #client;
  #sessions;
  #pages = new Map();
  #storageRoot;

  constructor(client, options = {}) {
    this.#client = client;
    this.#sessions = new SessionManager(client);
    this.tabs = new TabRepository(client);
    this.#storageRoot = path.resolve(options.storageRoot ?? process.cwd());
  }

  async initialize() {
    await this.#client.ensureConnected();
    return this;
  }

  get cdp() { return this.#client; }

  setDialogPolicy(policy) {
    if (typeof this.#client.setDialogPolicy !== "function") {
      throw new Error("dialog policy is not supported by this transport");
    }
    this.#client.setDialogPolicy(policy);
  }

  async listTargets() { return this.tabs.listTargets(); }

  async newTab(url = "about:blank") {
    const { createAgentTabs } = await import("./agent-tabs.js");
    return (await createAgentTabs(this).create(url)).page;
  }

  async attachPage(targetId) {
    if (this.#pages.has(targetId)) return this.#pages.get(targetId).page;
    const sessionId = await this.#sessions.resolvePageSession(targetId);
    const frames = new FrameManager(this.#client, targetId, sessionId);
    await frames.initialize();

    const entry = { frames, page: null };
    const host = this.#createPageHost(targetId, entry);
    const page = new OmOPage(this.#client, frames, targetId, sessionId, host);
    entry.page = page;
    this.#pages.set(targetId, entry);
    return page;
  }

  #createPageHost(targetId, entry) {
    return {
      daemonSession: { accountId: 0, id: "standalone" },
      extensionBridgeRoute: {},
      page: null,
      resolvePageSession: (id, preferred) => this.#sessions.resolvePageSession(id, preferred),
      resolvePath: value => path.resolve(this.#storageRoot, value),
      ensurePath: async value => {
        const resolved = path.resolve(this.#storageRoot, value);
        await mkdir(path.dirname(resolved), { recursive: true });
        return resolved;
      },
      registerReadableDownload: value => value,
      isReadableDownload: () => false,
      openPopupTab: async () => { throw Error("Popup tab control requires the extension bridge"); },
      closeTab: async (_page, options = {}) => {
        if (options.runBeforeUnload) {
          await this.#client.send("Page.close", undefined, await this.#sessions.resolvePageSession(targetId));
        } else {
          await this.#client.send("Target.closeTarget", { targetId });
        }
        await entry.page?.dispose();
        await entry.frames.dispose();
        this.#pages.delete(targetId);
      },
    };
  }

  async close() {
    for (const [targetId, entry] of [...this.#pages]) {
      await entry.page.dispose().catch(() => {});
      await entry.frames.dispose().catch(() => {});
      this.#pages.delete(targetId);
    }
    await this.#sessions.dispose();
    await this.#client.close();
  }
}

// The browser's WebSocket URL carries its GUID: a ws:// URL is one already, an
// HTTP endpoint answers it on /json/version (no WebSocket, so no consent prompt).
async function browserKey(client, cdpUrl) {
  if (/^wss?:\/\//.test(cdpUrl)) return cdpUrl;
  return (await client.discoverVersion()).webSocketDebuggerUrl;
}

// Attaches in one process share one connection per browser (#76): each new
// connection to a user's Chrome is a new "Allow remote debugging?" prompt.
function createClient(cdpHttpUrl, options) {
  if (typeof cdpHttpUrl !== "string" || cdpHttpUrl.length === 0) {
    throw new TypeError("connect(cdpHttpUrl) requires a Chromium CDP HTTP URL");
  }
  return new CdpClient({ cdpUrl: cdpHttpUrl, ...options.client, dialogPolicy: options.dialogPolicy ?? options.client?.dialogPolicy });
}

// A connection of its own, never shared: for callers that lease or own the
// connection themselves (the named-instance registry).
export async function openConnection(cdpHttpUrl, options = {}) {
  return new BrowserConnection(createClient(cdpHttpUrl, options), options).initialize();
}

export async function connect(cdpHttpUrl, options = {}) {
  const client = createClient(cdpHttpUrl, options);
  if (!canShareConnection(options)) return new BrowserConnection(client, options).initialize();
  const key = await browserKey(client, cdpHttpUrl);
  // Opened on the resolved GUID URL, never the port: a reconnect then reaches
  // only this browser, and fails once it is gone (#79 review).
  return acquireSharedConnection(key, options, {
    open: () => openConnection(key, options),
  });
}
