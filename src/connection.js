import path from "node:path";
import { mkdir } from "node:fs/promises";
import {
  CdpClient,
  FrameManager,
  OmOPage,
  SessionManager,
} from "./core.js";
import { acquireSharedConnection, canShareConnection } from "./shared-connections.js";
import { createAgentTabs, getAgentTabs } from "./agent-tabs.js";
import { repinViewport } from "./viewport.js";
import { BrowserContext } from "./browser-context.js";

export class TabRepository {
  #client;
  constructor(client) { this.#client = client; }
  async listTargets() { return this.#client.discoverTargets(); }
}

export class BrowserConnection {
  #client;
  #sessions;
  #pages = new Map();
  #contexts = new Map();
  #storageRoot;
  #popups = new Map();
  #popupTargets = new Map();
  #attachingPopups = new Map();
  #ownedPopups = new Set();
  #popupOff = [];

  constructor(client, options = {}) {
    this.#client = client;
    this.#sessions = new SessionManager(client);
    this.tabs = new TabRepository(client);
    this.#storageRoot = path.resolve(options.storageRoot ?? process.cwd());
    this.#popupOff.push(client.on("Target.targetCreated", ({ targetInfo }) => {
      if (targetInfo?.type !== "page" || !this.#acceptsPopup(targetInfo.openerId)) return;
      // Target discovery and Page.windowOpen are independently dispatched. Keep
      // the target's opener identity even when discovery wins that race.
      const targets = this.#popupTargets.get(targetInfo.openerId) ?? [];
      targets.push({ targetId: targetInfo.targetId });
      this.#popupTargets.set(targetInfo.openerId, targets);
      this.#matchPopups(targetInfo.openerId);
    }));
    this.#popupOff.push(client.on("Target.targetDestroyed", ({ targetId }) => {
      this.#ownedPopups.delete(targetId);
      const error = Error("Popup closed before attachment completed");
      this.#attachingPopups.get(targetId)?.reject(error);
      for (const targets of this.#popupTargets.values()) {
        const target = targets.find(target => target.targetId === targetId);
        if (target) target.error = error;
      }
    }));
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
    return (await (getAgentTabs(this) ?? createAgentTabs(this)).create(url)).page;
  }

  #acceptsPopup(openerId) {
    return !!getAgentTabs(this)?.get(openerId) &&
      this.#pages.get(openerId)?.page.events.listenerCount("popup") > 0;
  }

  #matchPopups(openerId) {
    const targets = this.#popupTargets.get(openerId);
    const queue = this.#popups.get(openerId);
    while (targets?.length && queue?.length) {
      const target = targets.shift();
      const pending = queue.shift();
      if (target.error) pending.reject(target.error);
      else {
        this.#attachingPopups.set(target.targetId, pending);
        this.#ownedPopups.add(target.targetId);
        pending.operation = this.#attachPopup(target.targetId, pending).catch(pending.reject).finally(() => {
          this.#attachingPopups.delete(target.targetId);
        });
      }
    }
    if (!targets?.length) this.#popupTargets.delete(openerId);
    if (!queue?.length) this.#popups.delete(openerId);
  }

  async #attachPopup(targetId, pending) {
    const tabs = getAgentTabs(this) ?? createAgentTabs(this);
    const { page } = await tabs.adopt(targetId);
    page.popupMetadata = Object.freeze(pending.metadata);
    await page.waitForLoadState("interactive");
    pending.resolve(page);
  }

  async attachPage(targetId) {
    if (this.#pages.has(targetId)) return this.#pages.get(targetId).page;
    const sessionId = await this.#sessions.resolvePageSession(targetId);
    const frames = new FrameManager(this.#client, targetId, sessionId);
    await frames.initialize();

    const entry = { frames, page: null };
    const host = this.#createPageHost(targetId, entry);
    const page = new OmOPage(this.#client, frames, targetId, sessionId, host);
    const { targetInfo } = await this.#client.send("Target.getTargetInfo", { targetId });
    const contextId = targetInfo.browserContextId;
    if (!this.#contexts.has(contextId)) this.#contexts.set(contextId, new BrowserContext(this, contextId));
    const context = this.#contexts.get(contextId);
    page.context = () => context;
    for (const frame of frames.frames.values()) context.trackOrigin(frame.url);
    page.on("framenavigated", frame => context.trackOrigin(frame.url));
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
      setViewportSize: async size => {
        const tabs = getAgentTabs(this);
        if (tabs?.get(targetId)) await tabs.repin(targetId, size);
        else await repinViewport(entry.page, size);
      },
      resolvePath: value => path.resolve(this.#storageRoot, value),
      ensurePath: async value => {
        const resolved = path.resolve(this.#storageRoot, value);
        await mkdir(path.dirname(resolved), { recursive: true });
        return resolved;
      },
      registerReadableDownload: value => value,
      isReadableDownload: () => false,
      resolvePopup: async metadata => {
        if (!this.#acceptsPopup(targetId)) return;
        const queue = this.#popups.get(targetId) ?? [];
        const promise = new Promise((resolve, reject) => queue.push({
          resolve, reject, metadata: { url: metadata.url, windowName: metadata.windowName },
        }));
        this.#popups.set(targetId, queue);
        this.#matchPopups(targetId);
        return promise;
      },
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
    for (const off of this.#popupOff) off();
    for (const queue of this.#popups.values()) {
      for (const pending of queue) pending.reject(Error("Browser connection closed"));
    }
    this.#popups.clear();
    this.#popupTargets.clear();
    for (const pending of this.#attachingPopups.values()) pending.reject(Error("Browser connection closed"));
    await Promise.all([...this.#attachingPopups.values()].map(pending => pending.operation));
    const tabs = getAgentTabs(this);
    if (tabs) {
      await Promise.all([...this.#ownedPopups].filter(id => tabs.get(id)).map(id => tabs.close(id)));
      await tabs.dispose({ closeOwned: false });
    }
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
    open: (snapshot) => openConnection(key, snapshot),
  });
}
