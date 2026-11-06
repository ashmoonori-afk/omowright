import { urlMatches } from "./url-match.js";

const sessions = new WeakMap();
const streams = new WeakMap();
const METHODS = [
  "Network.requestWillBeSent", "Network.responseReceived",
  "Network.loadingFinished", "Network.loadingFailed",
];

// Readiness tracking and user-facing capture share ownership of the domain.
// A refused enable is not a page-setup failure (embedded transports may refuse it).
export function acquireNetwork(cdp, sessionId) {
  let active = sessions.get(cdp);
  if (!active) sessions.set(cdp, active = new Map());
  let state = active.get(sessionId);
  if (!state) {
    state = { users: 0 };
    active.set(sessionId, state);
    state.ready = cdp.send("Network.enable", undefined, sessionId).catch(() => {});
  }
  state.users++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (--state.users) return;
    active.delete(sessionId);
    // Order disable before a subsequent acquire's enable, even if the first
    // enable has not completed yet.
    cdp.send("Network.disable", undefined, sessionId).catch(() => {});
  };
  release.ready = state.ready;
  return release;
}

export class NetworkBodyUnavailableError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "NetworkBodyUnavailableError";
  }
}

function headers(values = {}) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)]));
}

function bodyReaders(body) {
  return {
    body,
    async text() { return (await body()).toString("utf8"); },
    async json() { return JSON.parse(await this.text()); },
  };
}

function recordFor(cdp, sessionId, params) {
  const request = params.request ?? {};
  const finished = Promise.withResolvers();
  let rawBody;
  const record = {
    exposed: false,
    finish: finished.resolve,
    rawBody() {
      return rawBody ??= finished.promise.then(async failure => {
        try {
          if (failure) throw failure;
          return await cdp.send("Network.getResponseBody", { requestId: params.requestId }, sessionId);
        } catch (cause) {
          throw new NetworkBodyUnavailableError(`Response body is unavailable for ${request.url}`, cause);
        }
      });
    },
  };
  record.request = {
    url: () => request.url ?? params.documentURL ?? "",
    method: () => request.method ?? "GET",
    headers: () => headers(request.headers),
    ...bodyReaders(async () => Buffer.from(request.postData ?? "", "utf8")),
  };
  record.setResponse = response => {
    record.response = {
      url: () => response.url ?? record.request.url(),
      method: record.request.method,
      headers: () => headers(response.headers),
      status: () => response.status,
      ok: () => response.status >= 200 && response.status <= 299,
      ...bodyReaders(async () => {
        const result = await record.rawBody();
        return Buffer.from(result.body ?? "", result.base64Encoded ? "base64" : "utf8");
      }),
    };
  };
  return record;
}

// One CDP event path per page, shared by page events, snoops and traces.
// Network.enable itself is shared per session with the readiness tracker.
export function subscribeNetwork(page, handlers) {
  let stream = streams.get(page);
  if (!stream) {
    const observers = new Set();
    const inflight = new Map();
    const unsubscribers = [];
    let sessionId;
    let release;
    let closed = false;
    const ready = Promise.resolve(page.resolveSessionId()).then(async id => {
      sessionId = id;
      if (!closed) {
        release = acquireNetwork(page.cdp, id);
        await release.ready;
      }
    });
    ready.catch(() => {});
    const close = (force = false) => {
      if (closed || (!force && (observers.size || inflight.size))) return;
      closed = true;
      for (const record of inflight.values()) record.finish(Error("Page network capture disposed"));
      inflight.clear();
      observers.clear();
      for (const off of unsubscribers) off();
      release?.();
      streams.delete(page);
    };
    const dispatch = (method, params) => {
      let record = inflight.get(params.requestId);
      if (method === "Network.requestWillBeSent") {
        // Redirects reuse request ids; the previous hop has no readable body.
        record?.finish(Error("Request redirected"));
        record = recordFor(page.cdp, sessionId, params);
        inflight.set(params.requestId, record);
      } else if (method === "Network.responseReceived") {
        record?.setResponse(params.response ?? {});
      } else {
        record?.finish(method === "Network.loadingFailed" ? Error(params.errorText ?? "Request failed") : null);
      }
      for (const observer of observers) observer[method]?.(params, record);
      if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
        // Preserve bodies for returned response objects before the last
        // listener releases the domain (disable clears the browser cache).
        const done = record?.exposed && record.response
          ? record.rawBody().catch(() => {}) : Promise.resolve();
        done.finally(() => {
          if (inflight.get(params.requestId) === record) inflight.delete(params.requestId);
          close();
        });
      }
    };
    for (const method of METHODS) {
      unsubscribers.push(page.cdp.on(method, (params, meta) => {
        if (closed) return;
        if (sessionId === undefined) {
          ready.then(() => {
            if (!closed && meta?.sessionId === sessionId) dispatch(method, params);
          }).catch(() => {});
        } else if (meta?.sessionId === sessionId) dispatch(method, params);
      }));
    }
    stream = { observers, close, inflight, ready };
    streams.set(page, stream);
  }
  stream.observers.add(handlers);
  return () => {
    stream.observers.delete(handlers);
    // Unobserved requests without a returned response need no further work.
    for (const [id, record] of stream.inflight) {
      if (!record.exposed && !stream.observers.size) {
        record.finish(Error("Network capture disposed"));
        stream.inflight.delete(id);
      }
    }
    stream.close();
  };
}

// Holds the shared stream for one navigation call. A frame's document records
// are exposed so bodies stay readable after the domain is released.
export function trackDocumentResponses(page, frameId) {
  const documents = new Map();
  const dispose = subscribeNetwork(page, {
    "Network.requestWillBeSent": (params, record) => {
      if (params.type !== "Document" || params.frameId !== frameId) return;
      record.exposed = true;
      // Redirect hops share the loader id; the last hop carries the final response.
      documents.set(params.loaderId, record);
    },
  });
  return {
    ready: networkReady(page),
    response: loaderId => documents.get(loaderId)?.response ?? null,
    dispose,
  };
}

export function disposeNetwork(page) {
  streams.get(page)?.close(true);
}

export function networkReady(page) {
  return streams.get(page)?.ready;
}

export function subscribePageNetworkEvents(page) {
  const emit = (name, value) => page.events.emit(name, value)
    .catch(error => console.warn("[network] page event listener failed", error));
  return subscribeNetwork(page, {
    "Network.requestWillBeSent": (_params, record) => emit("request", record.request),
    "Network.responseReceived": (_params, record) => {
      if (!record) return;
      record.exposed = true;
      emit("response", record.response);
    },
  });
}

export function networkPredicate(match) {
  if (typeof match === "function") return match;
  if (match instanceof RegExp) return value => {
    match.lastIndex = 0;
    return match.test(value.url());
  };
  if (typeof match === "string") return value => urlMatches(value.url(), match);
  throw new TypeError("urlOrPredicate must be a URL string, RegExp or predicate");
}
