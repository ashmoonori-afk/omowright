import { subscribeNetwork } from "./network-events.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const JSON_MIME = /^application\/json\s*(;|$)|\+json\s*(;|$)/i;

function matchesText(value, pattern) {
  if (pattern === undefined) return true;
  if (value === null || value === undefined) return false;
  if (pattern instanceof RegExp) return pattern.test(String(value));
  return String(value).includes(String(pattern));
}

function matchesToken(value, expected) {
  if (expected === undefined) return true;
  if (value === null || value === undefined) return false;
  return String(value).toLowerCase() === String(expected).toLowerCase();
}

function toPredicate(match) {
  if (match === undefined || match === null) return () => true;
  if (typeof match === "function") return match;
  if (typeof match !== "object") throw new TypeError("match must be a predicate function or a descriptor object");
  return entry => matchesText(entry.url, match.url)
    && matchesToken(entry.method, match.method)
    && matchesText(entry.mimeType, match.mimeType)
    && matchesToken(entry.resourceType, match.resourceType);
}

function startedAtOf(params) {
  const wallTime = Number(params?.wallTime);
  return Number.isFinite(wallTime) && wallTime > 0 ? Math.round(wallTime * 1000) : Date.now();
}

function decodeBody(entry) {
  if (typeof entry.body !== "string") return null;
  return entry.base64Encoded ? Buffer.from(entry.body, "base64").toString("utf8") : entry.body;
}

/**
 * Buffers CDP network traffic for a single page session.
 *
 * Entries are tracked while in flight and committed to the buffer once they finish
 * (or fail), so filters may depend on response-only fields such as status or mimeType.
 */
export function createNetworkSnoop(page, options = {}) {
  if (!page?.cdp || typeof page.resolveSessionId !== "function") {
    throw new TypeError("createNetworkSnoop requires a page with cdp and resolveSessionId");
  }
  const { match, bodies = true, maxEntries = 500, maxBodyBytes = 5_000_000 } = options;
  const wanted = toPredicate(match);

  const inflight = new Map();
  const buffer = [];
  const waiters = new Set();
  const handlers = {};
  let disposed = false;
  let queue = Promise.resolve();

  function subscribe(method, handler) {
    handlers[method] = handler;
  }

  function enqueue(task) {
    queue = queue.then(task).catch(error => console.warn("[network-snoop] entry processing failed", error));
  }

  async function loadBody(entry, record) {
    if (entry.encodedDataLength > maxBodyBytes) {
      entry.bodySkipped = true;
      return;
    }
    try {
      const result = await record.rawBody();
      entry.body = result?.body ?? null;
      entry.base64Encoded = Boolean(result?.base64Encoded);
    } catch {
      // Bodies expire with the network cache; keep the entry, drop the body.
      entry.body = null;
    }
  }

  function commit(entry) {
    buffer.push(entry);
    while (buffer.length > maxEntries) buffer.shift();
    for (const waiter of [...waiters]) if (waiter.test(entry)) waiter.resolve(entry);
  }

  subscribe("Network.requestWillBeSent", params => {
    const requestId = params?.requestId;
    if (!requestId) return;
    inflight.set(requestId, {
      requestId,
      url: params.request?.url ?? params.documentURL ?? "",
      method: params.request?.method ?? "GET",
      resourceType: params.type ?? null,
      status: null,
      statusText: null,
      mimeType: null,
      requestHeaders: params.request?.headers ?? {},
      responseHeaders: null,
      remoteIPAddress: null,
      postData: params.request?.postData ?? null,
      encodedDataLength: 0,
      body: null,
      base64Encoded: false,
      bodySkipped: false,
      failed: false,
      errorText: null,
      startedAt: startedAtOf(params),
      finishedAt: null,
    });
  });

  subscribe("Network.responseReceived", params => {
    const entry = inflight.get(params?.requestId);
    if (!entry) return;
    const response = params.response ?? {};
    entry.status = response.status ?? null;
    entry.statusText = response.statusText ?? "";
    entry.mimeType = response.mimeType ?? null;
    entry.responseHeaders = response.headers ?? {};
    entry.remoteIPAddress = response.remoteIPAddress ?? null;
    if (params.type) entry.resourceType = params.type;
  });

  subscribe("Network.loadingFinished", (params, record) => {
    const entry = inflight.get(params?.requestId);
    if (!entry) return;
    inflight.delete(entry.requestId);
    entry.encodedDataLength = Number(params.encodedDataLength ?? 0);
    entry.finishedAt = Date.now();
    enqueue(async () => {
      if (!wanted(entry)) return;
      if (bodies) await loadBody(entry, record);
      commit(entry);
    });
  });

  subscribe("Network.loadingFailed", params => {
    const entry = inflight.get(params?.requestId);
    if (!entry) return;
    inflight.delete(entry.requestId);
    entry.failed = true;
    entry.errorText = params.errorText ?? "";
    entry.encodedDataLength = Number(params.encodedDataLength ?? entry.encodedDataLength);
    entry.finishedAt = Date.now();
    enqueue(async () => { if (wanted(entry)) commit(entry); });
  });

  function pop() {
    return buffer.splice(0, buffer.length);
  }

  function peek() {
    return [...buffer];
  }

  function popJson() {
    const values = [];
    for (const entry of pop()) {
      if (!JSON_MIME.test(String(entry.mimeType ?? ""))) continue;
      const text = decodeBody(entry);
      if (text === null) continue;
      try {
        values.push(JSON.parse(text));
      } catch {
        // Truncated or non-JSON payload on a JSON content type: drop it silently.
      }
    }
    return values;
  }

  function waitFor(match, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (disposed) return Promise.reject(Error("Network snoop is disposed"));
    const predicate = toPredicate(match);
    return new Promise((resolve, reject) => {
      let settled = false;
      const waiter = {};
      const finish = callback => value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiters.delete(waiter);
        callback(value);
      };
      waiter.resolve = finish(resolve);
      waiter.reject = finish(reject);
      waiter.test = entry => {
        try {
          return Boolean(predicate(entry));
        } catch (error) {
          waiter.reject(error instanceof Error ? error : Error(String(error)));
          return false;
        }
      };
      const timer = setTimeout(
        () => waiter.reject(Error(`Timed out waiting for network response after ${timeoutMs}ms`)),
        timeoutMs,
      );
      waiters.add(waiter);
    });
  }

  function summary({ max = 50 } = {}) {
    const shown = buffer.slice(0, max);
    const lines = shown.map(entry => [
      entry.method,
      entry.status ?? (entry.failed ? "FAILED" : "-"),
      entry.mimeType ?? "-",
      `${entry.encodedDataLength}B`,
      entry.url,
    ].join(" "));
    const hidden = buffer.length - shown.length;
    if (hidden > 0) lines.push(`... +${hidden} more`);
    return lines.join("\n");
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    for (const waiter of [...waiters]) waiter.reject(Error("Network snoop disposed"));
    waiters.clear();
    inflight.clear();
  }

  const unsubscribe = subscribeNetwork(page, handlers);
  return { pop, peek, popJson, waitFor, summary, dispose };
}
