import { spawn } from "node:child_process";
import { finished } from "node:stream/promises";
import {
  browserSpawnDetached,
  profileDirFromArgs,
  reapOrphanedBrowser,
  removeBrowserPidFile,
  terminateChild,
  writeBrowserPidFile,
} from "./browser-process.js";
import { BrowserConnection } from "./connection.js";
import { Dialog, answerWithPolicy, normalizeDialogPolicy } from "./dialog-policy.js";
import { targetCreationCapability } from "./internal-capability.js";
import { SerialEmitter as Emittery } from "./serial-emitter.js";
import { CdpCommandTimeoutError, CdpPipeClosedError, CdpSessionDetachedError, CdpSessionCrashedError } from "./cdp-errors.js";
export { CdpCommandTimeoutError, CdpPipeClosedError, CdpSessionDetachedError, CdpSessionCrashedError } from "./cdp-errors.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_READINESS_TIMEOUT_MS = 10_000;
const GRACEFUL_CLOSE_TIMEOUT_MS = 2_000;
const STDIO_TAIL_LIMIT = 16_384;
const EXIT_STDERR_DRAIN_MS = 1_000;

export class PipeCdpClient {
  #child;
  #writeStream;
  #readStream;
  #buffer = Buffer.alloc(0);
  #seq = 1;
  #pending = new Map();
  #closedSessions = new Set();
  #sessionTargets = new Map();
  #launch;
  #launchId;
  #launchedAt = 0;
  #receivedBytes = 0;
  #malformedFrameCount = 0;
  #events = new Emittery();
  #connected = false;
  #commandTimeoutMs;
  #readinessTimeoutMs;
  #browserPath;
  #browserArgs;
  #spawnOptions;
  #stdioTail = "";
  #stderrHead = "";
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
    // A spawn that fails (missing or non-executable browserPath) has no pid and
    // emits "error" instead of "spawn"; unheard, that error crashes the caller.
    const spawnFailed = new Promise(resolve => this.#child.once("error", resolve));
    if (this.#child.pid === undefined) {
      const error = await spawnFailed;
      this.#child = undefined;
      throw error;
    }
    const browserPid = this.#child.pid;
    // A helper process can keep an old launch's pipe open after that browser is
    // gone; its late events must never touch the launch that replaced it.
    const launch = {};
    this.#launch = launch;
    const owned = listener => (...args) => { if (this.#launch === launch) listener(...args); };
    this.#launchId = `${this.logId}:${browserPid}`;
    this.#launchedAt = performance.now();
    this.#receivedBytes = 0;
    this.#malformedFrameCount = 0;
    this.#buffer = Buffer.alloc(0);
    this.#sessionTargets.clear();
    this.#closedSessions.clear();
    this.#child.once("exit", () => removeBrowserPidFile(profileDir, browserPid));
    this.#stdioTail = "";
    this.#stderrHead = "";
    const stderr = this.#child.stderr;
    for (const stream of [this.#child.stdout, stderr]) {
      if (!stream) continue;
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        this.#stdioTail = (this.#stdioTail + chunk).slice(-STDIO_TAIL_LIMIT);
        // Only the first stderr line is read: stop growing the head once it holds
        // a complete non-blank line or is full.
        if (stream === stderr && this.#stderrHead.length < STDIO_TAIL_LIMIT && !this.#stderrHead.trimStart().includes("\n")) {
          this.#stderrHead = (this.#stderrHead + chunk).slice(0, STDIO_TAIL_LIMIT);
        }
      });
      stream.on("error", () => {});
    }
    this.#writeStream = this.#child.stdio[3];
    this.#readStream = this.#child.stdio[4];
    this.#readStream.on("data", owned(chunk => this.#onData(chunk)));
    for (const event of ["end", "close"]) {
      this.#readStream.on(event, owned(() => this.#failCommands(CdpPipeClosedError, `CDP pipe read stream ${event}`)));
    }
    // A killed browser resets its end of the CDP pipes (ECONNRESET/EPIPE on Linux);
    // without a listener Node rethrows that as an uncaught exception in the caller.
    for (const stream of [this.#writeStream, this.#readStream]) {
      stream.on("error", owned(error => this.#failAll(Error(`CDP pipe error: ${error.code ?? error.message}`))));
    }
    this.#child.on("exit", owned(() => {
      this.#connected = false;
      this.#failAll(Error("CDP pipe browser exited"));
      this.transportEvents.emit("disconnected").catch(() => {});
    }));
    try {
      await writeBrowserPidFile(profileDir, browserPid);
    } catch (error) {
      await this.#quitFailedLaunch();
      throw error;
    }
    this.#connected = true;
    try {
      await this.#awaitReady();
      await this.#dispatch("Target.setDiscoverTargets", { discover: true }).catch(() => {});
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

  // Probes go through #dispatch, never send(): send() would relaunch a browser
  // that exited mid-check, each relaunch with a fresh budget (#123). A browser
  // that exits fails the launch at once, naming the exit.
  async #awaitReady() {
    const child = this.#child;
    const deadline = Date.now() + this.#readinessTimeoutMs;
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve("exited")
      : new Promise(resolve => child.once("exit", () => resolve("exited")));
    let lastError;
    while (Date.now() < deadline) {
      try {
        const outcome = await Promise.race([
          this.#dispatch("Browser.getVersion", undefined, undefined, { timeoutMs: 1000 }),
          exited,
        ]);
        if (outcome !== "exited") return;
      } catch (error) {
        lastError = error;
      }
      if (child.exitCode !== null || child.signalCode !== null) throw await this.#exitedBeforeReady(child, deadline);
      let timer;
      try {
        await Promise.race([new Promise(resolve => { timer = setTimeout(resolve, 100); }), exited]);
      } finally {
        clearTimeout(timer);
      }
    }
    const reason = lastError ? String(lastError.message ?? lastError) : "no response";
    const tail = this.#stdioTail.trim();
    throw Error(
      `Browser did not become ready over the CDP pipe (${reason})` +
      (tail ? `\nBrowser stdio tail:\n${tail}` : ""),
    );
  }

  async #exitedBeforeReady(child, deadline) {
    // stderr can still hold unread output when "exit" fires; drain it. Bounded:
    // a surviving grandchild may hold the write end open indefinitely.
    if (child.stderr) {
      let timer;
      await Promise.race([
        finished(child.stderr).catch(() => {}),
        new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, Math.min(EXIT_STDERR_DRAIN_MS, deadline - Date.now()))); }),
      ]);
      clearTimeout(timer);
    }
    const how = child.signalCode ? `signal ${child.signalCode}` : `exit code ${child.exitCode}`;
    const firstLine = this.#stderrHead.split("\n").map(line => line.trim()).find(Boolean);
    // The first line already follows the colon; drop its repeat from the tail.
    const tailLines = this.#stdioTail.trim().split("\n");
    const repeat = tailLines.findIndex(line => line.trim() === firstLine);
    if (repeat !== -1) tailLines.splice(repeat, 1);
    const tail = tailLines.join("\n").trim();
    return Error(
      `Browser exited before it became ready over the CDP pipe (${how})` +
      (firstLine ? `: ${firstLine}` : "") +
      (tail ? `\nBrowser stdio tail:\n${tail}` : ""),
    );
  }

  async send(method, params, sessionId, opts = {}) {
    if (method === "Target.createTarget" && opts.capability !== targetCreationCapability) throw Error("Target.createTarget is reserved for createAgentTabs");
    if (String(method).startsWith("OmO.")) {
      throw Error(`Extension commands are unavailable over pipe transport: ${method}`);
    }
    await this.ensureConnected();
    return this.#dispatch(method, params, sessionId, opts);
  }

  async #dispatch(method, params, sessionId, opts = {}) {
    const id = this.#seq++;
    const msg = { id, method };
    if (params !== undefined) msg.params = params;
    if (sessionId) msg.sessionId = sessionId;
    const entry = {
      method, sessionId, targetId: params?.targetId ?? this.#sessionTargets.get(sessionId),
      sentAt: performance.now(), receivedBytes: this.#receivedBytes,
    };
    if (this.#closedSessions.has(sessionId) && method !== "Page.close") {
      throw this.#commandError(CdpSessionDetachedError, "Page closed", entry);
    }
    if (this.#readStream.readableEnded || this.#readStream.destroyed) {
      throw this.#commandError(CdpPipeClosedError, "CDP pipe read stream closed", entry);
    }
    const { promise, resolve, reject } = Promise.withResolvers();
    const timeoutMs = opts.timeoutMs ?? this.#commandTimeoutMs;
    const timeout = timeoutMs > 0
      ? setTimeout(() => {
        this.#pending.delete(id);
        reject(this.#commandError(CdpCommandTimeoutError, "CDP command timeout", entry));
      }, timeoutMs)
      : undefined;
    this.#pending.set(id, { ...entry, resolve, reject, timeout });
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


  closeSession(sessionId) {
    this.#closedSessions.add(sessionId);
    this.#failCommands(CdpSessionDetachedError, "Page closed", sessionId);
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
        let timer;
        try {
          await Promise.race([
            exited,
            new Promise(resolve => { timer = setTimeout(resolve, GRACEFUL_CLOSE_TIMEOUT_MS); }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      await terminateChild(child, { quitRequested });
      return;
    }
    this.#connected = false;
    this.#failAll(Error("CDP pipe client closed"));
  }

  #onData(chunk) {
    this.#receivedBytes += chunk.length;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    let idx;
    while ((idx = this.#buffer.indexOf(0)) !== -1) {
      const raw = this.#buffer.subarray(0, idx).toString("utf8");
      this.#buffer = this.#buffer.subarray(idx + 1);
      if (raw.length === 0) continue;
      let msg;
      try { msg = JSON.parse(raw); } catch { this.#malformedFrameCount++; continue; }
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
        if (entry.method === "Target.attachToTarget" && msg.result?.sessionId) {
          this.#sessionTargets.set(msg.result.sessionId, entry.targetId);
        }
        entry.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === "string") {
      if (msg.method === "Target.attachedToTarget" && msg.params?.sessionId && msg.params.targetInfo?.targetId) {
        this.#sessionTargets.set(msg.params.sessionId, msg.params.targetInfo.targetId);
      } else if (msg.method === "Target.detachedFromTarget" && msg.params?.sessionId) {
        this.#failCommands(CdpSessionDetachedError, "CDP session detached", msg.params.sessionId);
        this.#sessionTargets.delete(msg.params.sessionId);
      } else if (msg.method === "Inspector.targetCrashed" && msg.sessionId) {
        // The session outlives a renderer crash and Page.reload brings the target
        // back: Chromium answers a pending reload, so leave it and keep the
        // session's target. Commands the dead renderer held are answered only by a
        // later reload, with "Target crashed"; reject those now.
        this.#failCommands(CdpSessionCrashedError, "CDP session crashed", msg.sessionId, "Page.reload");
      }
      const meta = { sessionId: msg.sessionId };
      if (msg.method === "Page.javascriptDialogOpening" && msg.sessionId) {
        meta.dialog = new Dialog(msg.params, action => this.send("Page.handleJavaScriptDialog", action, msg.sessionId));
      }
      const emitted = this.#events.emit(msg.method, { data: { payload: msg.params, meta } }).catch(() => {});
      return meta.dialog
        ? emitted.then(() => answerWithPolicy(meta.dialog, this.#dialogPolicy, msg.params)).catch(() => {})
        : undefined;
    }
  }

  #commandError(ErrorType, reason, entry) {
    const now = performance.now();
    const receivedBytesSinceSend = this.#receivedBytes - entry.receivedBytes;
    const details = {
      method: entry.method, launchId: this.#launchId,
      sessionId: entry.sessionId ?? null,
      targetId: entry.targetId ?? this.#sessionTargets.get(entry.sessionId) ?? null,
      elapsedSinceLaunchMs: Math.round(now - this.#launchedAt),
      commandElapsedMs: Math.round(now - entry.sentAt),
      receivedReplyBytes: receivedBytesSinceSend > 0, receivedBytesSinceSend,
      malformedFrameCount: this.#malformedFrameCount,
    };
    const context = Object.entries(details).map(([key, value]) => `${key}=${value}`).join(", ");
    return new ErrorType(`${reason}: ${entry.method} (${context})`, details);
  }

  #failCommands(ErrorType, reason, sessionId, sparedMethod) {
    for (const [id, entry] of this.#pending) {
      if (sessionId !== undefined && entry.sessionId !== sessionId) continue;
      if (entry.method === sparedMethod) continue;
      if (entry.timeout) clearTimeout(entry.timeout);
      this.#pending.delete(id);
      entry.reject(this.#commandError(ErrorType, reason, entry));
    }
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
