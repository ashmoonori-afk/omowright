import { spawn } from "node:child_process";
import {
  browserSpawnDetached,
  profileDirFromArgs,
  reapOrphanedBrowser,
  removeBrowserPidFile,
  terminateChild,
  writeBrowserPidFile,
} from "./browser-process.js";
import { BrowserConnection } from "./connection.js";
import { normalizeDialogPolicy, resolveDialogAction } from "./dialog-policy.js";
import { targetCreationCapability } from "./internal-capability.js";
import { SerialEmitter as Emittery } from "./serial-emitter.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_READINESS_TIMEOUT_MS = 10_000;
const GRACEFUL_CLOSE_TIMEOUT_MS = 2_000;
const STDIO_TAIL_LIMIT = 16_384;

export class PipeCdpClient {
  #child;
  #writeStream;
  #readStream;
  #buffer = Buffer.alloc(0);
  #seq = 1;
  #pending = new Map();
  #events = new Emittery();
  #connected = false;
  #commandTimeoutMs;
  #readinessTimeoutMs;
  #browserPath;
  #browserArgs;
  #spawnOptions;
  #stdioTail = "";
  #dialogPolicy;
  transportEvents = new Emittery();
  logId;

  constructor({ browserPath, browserArgs = [], spawnOptions = {}, commandTimeoutMs, readinessTimeoutMs, logId, dialogPolicy }) {
    if (!browserPath) throw new TypeError("PipeCdpClient requires browserPath");
    this.#browserPath = browserPath;
    this.#browserArgs = browserArgs;
    this.#spawnOptions = spawnOptions;
    this.#commandTimeoutMs = commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.#readinessTimeoutMs = readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.logId = logId ?? `cdp-pipe-${Date.now()}`;
    this.#dialogPolicy = normalizeDialogPolicy(dialogPolicy);
  }

  get isConnected() { return this.#connected; }
  get isHeadless() { return this.#browserArgs.some(arg => /^--headless(?:=|$)/.test(arg)); }
  get childProcess() { return this.#child; }
  get dialogPolicy() { return this.#dialogPolicy; }

  setDialogPolicy(policy) {
    this.#dialogPolicy = normalizeDialogPolicy(policy);
  }

  async ensureConnected() {
    if (this.#connected) return;
    // Never inherit stdout/stderr: Chromium writes startup noise to both (e.g.
    // the PartitionAlloc shim's "Trying to load the allocator multiple times"
    // line and GoogleUpdater child logs), and inherited fds would spray it raw
    // onto the caller's tty (it corrupted the senpi TUI). Pipe + drain into a
    // bounded tail kept for launch diagnostics.
    const stdio = ["ignore", "pipe", "pipe", "pipe", "pipe"];
    const profileDir = profileDirFromArgs(this.#browserArgs);
    await reapOrphanedBrowser(profileDir);
    this.#child = spawn(this.#browserPath, [...this.#browserArgs, "--remote-debugging-pipe"], {
      detached: browserSpawnDetached,
      ...this.#spawnOptions,
      stdio,
    });
    const browserPid = this.#child.pid;
    this.#child.once("exit", () => removeBrowserPidFile(profileDir, browserPid));
    this.#stdioTail = "";
    for (const stream of [this.#child.stdout, this.#child.stderr]) {
      if (!stream) continue;
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        this.#stdioTail = (this.#stdioTail + chunk).slice(-STDIO_TAIL_LIMIT);
      });
      stream.on("error", () => {});
    }
    this.#writeStream = this.#child.stdio[3];
    this.#readStream = this.#child.stdio[4];
    this.#readStream.on("data", chunk => this.#onData(chunk));
    // A killed browser resets its end of the CDP pipes (ECONNRESET/EPIPE on Linux);
    // without a listener Node rethrows that as an uncaught exception in the caller.
    for (const stream of [this.#writeStream, this.#readStream]) {
      stream.on("error", error => this.#failAll(Error(`CDP pipe error: ${error.code ?? error.message}`)));
    }
    this.#child.on("exit", () => {
      this.#connected = false;
      this.#failAll(Error("CDP pipe browser exited"));
      this.transportEvents.emit("disconnected").catch(() => {});
    });
    try {
      await writeBrowserPidFile(profileDir, browserPid);
    } catch (error) {
      await this.#quitFailedLaunch();
      throw error;
    }
    this.#connected = true;
    try {
      await this.#awaitReady();
      await this.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
      await this.transportEvents.emit("connected");
    } catch (error) {
      await this.#quitFailedLaunch();
      throw error;
    }
  }

  // Never leave a browser the caller holds no handle to: a rejected launch hands
  // back no client, so quit it (SIGTERM, then the bounded grace) before reporting.
  async #quitFailedLaunch() {
    const child = this.#child;
    this.#child = undefined;
    this.#connected = false;
    this.#failAll(Error("CDP pipe launch failed"));
    await terminateChild(child);
  }

  async #awaitReady() {
    const deadline = Date.now() + this.#readinessTimeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        await this.send("Browser.getVersion", undefined, undefined, { timeoutMs: 1000 });
        return;
      } catch (error) {
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    const reason = lastError ? String(lastError.message ?? lastError) : "no response";
    const tail = this.#stdioTail.trim();
    throw Error(
      `Browser did not become ready over the CDP pipe (${reason})` +
      (tail ? `\nBrowser stdio tail:\n${tail}` : ""),
    );
  }

  async send(method, params, sessionId, opts = {}) {
    if (method === "Target.createTarget" && opts.capability !== targetCreationCapability) throw Error("Target.createTarget is reserved for createAgentTabs");
    if (String(method).startsWith("OmO.")) {
      throw Error(`Extension commands are unavailable over pipe transport: ${method}`);
    }
    await this.ensureConnected();
    const id = this.#seq++;
    const msg = { id, method };
    if (params !== undefined) msg.params = params;
    if (sessionId) msg.sessionId = sessionId;
    const { promise, resolve, reject } = Promise.withResolvers();
    const timeoutMs = opts.timeoutMs ?? this.#commandTimeoutMs;
    const timeout = timeoutMs > 0
      ? setTimeout(() => { this.#pending.delete(id); reject(Error(`CDP command timeout: ${method}`)); }, timeoutMs)
      : undefined;
    this.#pending.set(id, { method, resolve, reject, timeout });
    this.#writeStream.write(JSON.stringify(msg) + "\0");
    return promise;
  }

  on(method, fn) {
    return this.#events.on(method, ({ data }) => fn(data.payload, data.meta));
  }

  async discoverTargets() {
    const { targetInfos } = await this.send("Target.getTargets");
    return targetInfos.map(t => ({
      id: t.targetId,
      type: t.type,
      url: t.url ?? "",
      title: t.title ?? "",
      description: t.description,
      faviconUrl: t.faviconUrl,
      parentId: t.openerId,
    }));
  }


  async close() {
    const child = this.#child;
    this.#child = undefined;
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once("exit", resolve));
      let quitRequested = false;
      if (this.#connected) {
        await Promise.race([
          this.send("Browser.close", undefined, undefined, {
            timeoutMs: GRACEFUL_CLOSE_TIMEOUT_MS,
          }).then(() => { quitRequested = true; }, () => {}),
          exited,
        ]);
      }
      this.#connected = false;
      this.#failAll(Error("CDP pipe client closed"));
      if (child.exitCode === null) {
        await Promise.race([
          exited,
          new Promise(resolve => setTimeout(resolve, GRACEFUL_CLOSE_TIMEOUT_MS)),
        ]);
      }
      await terminateChild(child, { quitRequested });
      return;
    }
    this.#connected = false;
    this.#failAll(Error("CDP pipe client closed"));
  }

  #onData(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    let idx;
    while ((idx = this.#buffer.indexOf(0)) !== -1) {
      const raw = this.#buffer.subarray(0, idx).toString("utf8");
      this.#buffer = this.#buffer.subarray(idx + 1);
      if (raw.length === 0) continue;
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      this._handleTransportMessage(msg);
    }
  }

  _handleTransportMessage(msg) {
    if (typeof msg.id === "number") {
      const entry = this.#pending.get(msg.id);
      if (!entry) return;
      this.#pending.delete(msg.id);
      if (entry.timeout) clearTimeout(entry.timeout);
      if (msg.error) {
        const err = Error(msg.error.message ?? `CDP command failed: ${entry.method}`);
        err.code = msg.error.code;
        err.data = msg.error.data;
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === "string") {
      const handled = msg.method === "Page.javascriptDialogOpening" && msg.sessionId
        ? this.#handleJavaScriptDialog(msg).catch(() => {})
        : undefined;
      this.#events.emit(msg.method, { data: { payload: msg.params, meta: { sessionId: msg.sessionId } } }).catch(() => {});
      return handled;
    }
  }

  async #handleJavaScriptDialog(msg) {
    const params = await resolveDialogAction(this.#dialogPolicy, msg.params);
    await this.send("Page.handleJavaScriptDialog", params, msg.sessionId);
  }

  #failAll(err) {
    for (const entry of this.#pending.values()) {
      if (entry.timeout) clearTimeout(entry.timeout);
      entry.reject(err);
    }
    this.#pending.clear();
  }
}

export async function connectPipe({ browserPath, browserArgs = [], spawnOptions, storageRoot, commandTimeoutMs, readinessTimeoutMs, logId, dialogPolicy } = {}) {
  const client = new PipeCdpClient({ browserPath, browserArgs, spawnOptions, commandTimeoutMs, readinessTimeoutMs, logId, dialogPolicy });
  await client.ensureConnected();
  const connection = new BrowserConnection(client, { storageRoot });
  await connection.initialize();
  connection.browserProcess = client.childProcess;
  return connection;
}
