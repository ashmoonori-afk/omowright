import { DEFAULT_AGENT_VIEWPORT, repinViewport } from "./viewport.js";
import { targetCreationCapability } from "./internal-capability.js";

const managers = new WeakMap();
const CAPABILITY = targetCreationCapability;

function optionsKey(options = {}) {
  return JSON.stringify({
    viewport: { ...DEFAULT_AGENT_VIEWPORT, ...(options.viewport ?? {}) },
    closeTimeoutMs: options.closeTimeoutMs ?? 5_000,
  });
}

export class AgentTabManager {
  #connection;
  #owned = new Map();
  #unsubscribers = [];
  #disposed = false;
  #closing = new Map();
  viewport;
  closeTimeoutMs;
  ready;

  constructor(connection, options = {}) {
    if (!connection?.cdp) throw new TypeError("createAgentTabs requires a browser connection");
    this.#connection = connection;
    this.viewport = Object.freeze({ ...DEFAULT_AGENT_VIEWPORT, ...(options.viewport ?? {}) });
    this.closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
    this.#unsubscribers.push(connection.cdp.on("Target.targetDestroyed", info => this.#destroyed(info?.targetId)));
    this.#unsubscribers.push(connection.cdp.on("Target.targetCrashed", info => this.#destroyed(info?.targetId)));
    this.#unsubscribers.push(connection.cdp.transportEvents?.on?.("disconnected", () => {
      for (const id of [...this.#owned.keys()]) this.#destroyed(id, Error("Browser transport disconnected"));
    }));
    this.ready = Promise.resolve(connection.cdp.ensureConnected?.());
  }

  async create(url = "about:blank", options = {}) {
    if (this.#disposed) throw Error("Agent tab manager is disposed");
    await this.ready;
    const viewport = { ...this.viewport, ...(options.viewport ?? {}) };
    // A headed browser keeps a background tab in a shared window hidden: it never
    // paints (Page.captureScreenshot hangs) and requestAnimationFrame never fires.
    // Its own window doesn't take focus from the user's tab, and the tab renders
    // (verified headed on Linux and macOS).
    const result = await this.#connection.cdp.send("Target.createTarget", { url, background: true, newWindow: true }, undefined, { capability: CAPABILITY });
    const targetId = result.targetId;
    // CloakBrowser headless defers renderer startup for background targets until
    // activation; activating before attach avoids Page.enable timing out.
    if (await this.#isHeadless()) await this.#connection.cdp.send("Target.activateTarget", { targetId });
    return this.adopt(targetId, { viewport });
  }

  async adopt(targetId, options = {}) {
    if (this.#disposed) throw Error("Agent tab manager is disposed");
    const existing = this.#owned.get(targetId);
    if (existing) return this.#public(existing);
    const viewport = { ...this.viewport, ...(options.viewport ?? {}) };
    const record = { targetId, page: null, viewport: Object.freeze({ ...viewport }), repinQueue: Promise.resolve() };
    this.#owned.set(targetId, record);
    try {
      record.page = await this.#connection.attachPage(targetId);
      await repinViewport(record.page, record.viewport);
      record.navigationOff = record.page.on?.("framenavigated", event => {
        if (!event.parentFrameId) this.#repin(record);
      });
      return this.#public(record);
    } catch (error) {
      await this.#connection.cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      throw error;
    }
  }

  #public(record) {
    return Object.freeze({ targetId: record.targetId, page: record.page, viewport: { ...record.viewport }, close: options => this.close(record.targetId, options) });
  }
  get(targetId) { const record = this.#owned.get(targetId); return record ? this.#public(record) : null; }
  list() { return [...this.#owned.values()].map(record => this.#public(record)); }
  async #isHeadless() {
    if (typeof this.#connection.cdp.isHeadless === "boolean") return this.#connection.cdp.isHeadless;
    const version = await this.#connection.cdp.send("Browser.getVersion").catch(() => null);
    return /Headless/i.test(version?.product ?? "");
  }
  #queueRepin(record, viewport, reportErrors = false) {
    const size = { ...viewport };
    const operation = record.repinQueue.then(async () => {
      try { await repinViewport(record.page, size); }
      catch (error) { if (reportErrors) console.warn(`[agent-tabs] viewport repin failed for ${record.targetId}`, error); else throw error; }
      record.viewport = Object.freeze(size);
      return { ...size };
    });
    record.repinQueue = operation.catch(() => {});
    return operation;
  }
  async #repin(record) { await this.#queueRepin(record, record.viewport, true); }
  async repin(tabOrTargetId, viewport = this.viewport) {
    const id = typeof tabOrTargetId === "string" ? tabOrTargetId : tabOrTargetId?.targetId;
    const record = this.#owned.get(id);
    if (!record) throw Error(`Target ${id} is not owned by this manager`);
    return this.#queueRepin(record, viewport);
  }

  async close(tabOrTargetId, options = {}) {
    const id = typeof tabOrTargetId === "string" ? tabOrTargetId : tabOrTargetId?.targetId;
    const record = this.#owned.get(id);
    if (!record) throw Error(`Target ${id} is not owned by this manager`);
    const existing = this.#closing.get(id);
    if (existing) return existing.promise;
    let resolveOperation, rejectOperation;
    const promise = new Promise((resolve, reject) => { resolveOperation = resolve; rejectOperation = reject; });
    const entry = { promise, reject: rejectOperation };
    this.#closing.set(id, entry);
    this.#close(record, options).then(resolveOperation, rejectOperation).finally(() => {
      if (this.#closing.get(id) === entry) this.#closing.delete(id);
    });
    return promise;
  }

  async #close(record, options) {
    let resolveDestroy, rejectDestroy;
    const destroyed = new Promise((resolve, reject) => { resolveDestroy = resolve; rejectDestroy = reject; });
    const timeout = setTimeout(() => rejectDestroy(Error(`Timed out waiting for target ${record.targetId} to close`)), options.timeoutMs ?? this.closeTimeoutMs);
    const off = this.#connection.cdp.on("Target.targetDestroyed", info => { if (info?.targetId === record.targetId) resolveDestroy(); });
    const offDisconnect = this.#connection.cdp.transportEvents?.on?.("disconnected", () => rejectDestroy(Error("Browser transport disconnected")));
    try {
      if (options.runBeforeUnload && record.page) await record.page.cdp.send("Page.close", undefined, await record.page.resolveSessionId()).catch(() => this.#connection.cdp.send("Target.closeTarget", { targetId: record.targetId }));
      else await this.#connection.cdp.send("Target.closeTarget", { targetId: record.targetId });
      if (this.#owned.has(record.targetId)) await destroyed;
    } finally {
      clearTimeout(timeout); off(); offDisconnect?.();
      // Ownership is removed only by Target.targetDestroyed (or transport loss).
      if (!this.#owned.has(record.targetId)) record.navigationOff?.();
    }
  }

  #destroyed(id, error) {
    const record = this.#owned.get(id);
    if (!record) return;
    record.navigationOff?.();
    this.#owned.delete(id);
    if (error) this.#closing.get(id)?.reject(error);
  }
  async closeAll(options = {}) {
    const results = await Promise.allSettled([...this.#owned.keys()].map(id => this.close(id, options)));
    const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
    if (failures.length) throw new AggregateError(failures, "Failed to close one or more agent tabs");
  }
  async dispose(options = { closeOwned: true }) {
    if (this.#disposed) return;
    let failure;
    if (options.closeOwned !== false) try { await this.closeAll(options); } catch (error) { failure = error; }
    this.#disposed = true;
    for (const off of this.#unsubscribers) off();
    this.#unsubscribers = [];
    if (failure) throw failure;
  }
}

export function getAgentTabs(connection) {
  return managers.get(connection);
}

export function createAgentTabs(connection, options = {}) {
  const current = managers.get(connection);
  if (current) {
    if (current._optionsKey !== optionsKey(options)) throw new TypeError("Conflicting AgentTabManager options");
    return current;
  }
  const manager = new AgentTabManager(connection, options);
  Object.defineProperty(manager, "_optionsKey", { value: optionsKey(options) });
  managers.set(connection, manager);
  return manager;
}
