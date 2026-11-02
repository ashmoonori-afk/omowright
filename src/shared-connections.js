import { isDeepStrictEqual } from "node:util";

// One CDP connection per browser per process (#68). Chrome asks the user to
// allow remote debugging once per WebSocket connection to their own profile,
// so an attach that opens a fresh socket on every call prompts on every call.
// Entries are keyed by the browser's webSocketDebuggerUrl: it carries the
// browser GUID, so a restarted or different browser never gets a cached
// connection. Each caller gets a lease whose close() is a release; the last
// release disconnects, because an open socket keeps the process alive.
const shared = new Map();

function withinTimeout(pending, timeoutMs, message) {
  let timer;
  return Promise.race([
    pending,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function release(key, entry) {
  entry.refs -= 1;
  if (entry.refs > 0) return Promise.resolve();
  if (shared.get(key) === entry) shared.delete(key);
  return entry.ready.then(
    (connection) => connection.close(),
    () => {},
  );
}

function bindTo(target, value) {
  return typeof value === "function" ? value.bind(target) : value;
}

// Thrown when a holder tries to change a setting every other holder of the
// connection shares. Opening with that setting gives the holder its own.
export class SharedConnectionError extends Error {
  constructor() {
    super("this browser connection is shared; pass dialogPolicy to connect()/connectNamed() so this holder gets its own connection");
    this.name = "SharedConnectionError";
    this.code = "shared_connection";
  }
}

// Members the lease itself provides; a handle can't replace them.
const RESERVED = new Set(["cdp", "close", "setDialogPolicy"]);

function refuse(what) {
  return (_target, property) => {
    throw new TypeError(`cannot change ${String(property)} on ${what} through a handle: every holder of this connection uses it`);
  };
}

// A lease is one holder's view of the shared connection, and a holder never
// changes what another holder gets (#72 review):
// - setDialogPolicy works for a sole holder and makes the connection
//   unshareable from then on; while others hold it, it throws
//   SharedConnectionError instead (pages are shared, so a policy can't be
//   scoped to one holder, and moving the holder would orphan its pages).
// - Properties set or defined on the lease stay on the lease; shared ones can't
//   be deleted through it, and the shared client can't be written through it.
// - Listeners added through lease.cdp are removed when the lease closes, and
//   lease.cdp.close() releases only this lease.
// - After close() the lease refuses every use, so a stale handle can never
//   reopen a connection nobody owns.
function lease(key, entry, connection) {
  let closed;
  const overlay = Object.create(null);
  const subscriptions = [];
  // Symbols and `then` stay readable, so inspecting or resolving a closed
  // handle doesn't throw; every named member does.
  const ensureOpen = (property) => {
    if (closed && typeof property === "string" && property !== "then") {
      throw new Error("this browser connection handle was closed");
    }
  };
  const close = () => {
    if (!closed) {
      for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
      closed = release(key, entry);
    }
    return closed;
  };
  const setDialogPolicy = (policy) => {
    ensureOpen("setDialogPolicy");
    if (entry.refs > 1) throw new SharedConnectionError();
    if (shared.get(key) === entry) shared.delete(key);
    return connection.setDialogPolicy(policy);
  };
  const tracked = (subscribe) => (...args) => {
    const unsubscribe = subscribe(...args);
    subscriptions.push(unsubscribe);
    return unsubscribe;
  };
  const readOnly = (what, get) => ({
    get,
    set: refuse(what),
    defineProperty: refuse(what),
    deleteProperty: refuse(what),
  });
  const client = connection.cdp;
  // Transport events reach every holder: through a handle, clearListeners
  // removes only that handle's listeners and emit is refused.
  const transportSubscriptions = [];
  const transportEvents = new Proxy(client.transportEvents, readOnly("the shared transport events", (target, property) => {
    ensureOpen(property);
    if (property === "on") {
      return (...args) => {
        const unsubscribe = tracked(target.on.bind(target))(...args);
        transportSubscriptions.push(unsubscribe);
        return unsubscribe;
      };
    }
    if (property === "clearListeners") {
      return () => {
        for (const unsubscribe of transportSubscriptions.splice(0)) unsubscribe();
      };
    }
    if (property === "emit") {
      return () => {
        throw new TypeError("cannot emit transport events through a handle: every holder of this connection hears them");
      };
    }
    return bindTo(target, Reflect.get(target, property, target));
  }));
  const clientView = new Proxy(client, readOnly("the shared CDP client", (target, property) => {
    ensureOpen(property);
    if (property === "setDialogPolicy") return setDialogPolicy;
    if (property === "close") return close;
    if (property === "on") return tracked(target.on.bind(target));
    if (property === "transportEvents") return transportEvents;
    return bindTo(target, Reflect.get(target, property, target));
  }));
  return new Proxy(connection, {
    get(target, property) {
      if (property === "close") return close;
      ensureOpen(property);
      if (property === "setDialogPolicy") return setDialogPolicy;
      if (property === "cdp") return clientView;
      if (Object.hasOwn(overlay, property)) return overlay[property];
      return bindTo(target, Reflect.get(target, property, target));
    },
    set(target, property, value) {
      ensureOpen(property);
      if (RESERVED.has(property)) return refuse("a handle")(target, property);
      return Reflect.set(overlay, property, value);
    },
    defineProperty(target, property, descriptor) {
      ensureOpen(property);
      if (RESERVED.has(property)) return refuse("a handle")(target, property);
      // A non-configurable property can't live on the lease alone.
      if (descriptor.configurable !== true) return false;
      return Reflect.defineProperty(overlay, property, descriptor);
    },
    deleteProperty(target, property) {
      ensureOpen(property);
      if (Object.hasOwn(overlay, property)) return Reflect.deleteProperty(overlay, property);
      return refuse("the shared connection")(target, property);
    },
    has(target, property) {
      return Object.hasOwn(overlay, property) || Reflect.has(target, property);
    },
    ownKeys(target) {
      return [...new Set([...Reflect.ownKeys(target), ...Reflect.ownKeys(overlay)])];
    },
    getOwnPropertyDescriptor(target, property) {
      return Object.hasOwn(overlay, property)
        ? Reflect.getOwnPropertyDescriptor(overlay, property)
        : Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
}

// Only plain data is compared structurally, and isDeepStrictEqual sees only
// enumerable values. So options are shared only when every own key is an
// enumerable, string-keyed data property and nothing refers back to itself;
// a class instance (an authorizer keeping its token in a private field), a
// symbol or non-enumerable key, an accessor or a cycle makes them unshareable.
// Functions compare by identity, which is exact.
function isPlainData(value, path = new Set()) {
  if (typeof value === "function" || value === null || typeof value !== "object") return true;
  if (path.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  path.add(value);
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (isArray && key === "length") continue;
      if (typeof key === "symbol") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !("value" in descriptor)) return false;
      if (!isPlainData(descriptor.value, path)) return false;
    }
    return true;
  } finally {
    path.delete(value);
  }
}

// An authorizer is a credential: two callers never share one connection
// through it, even with the same authorizer object (#79 review).
export function canShareConnection(options) {
  return options?.client?.authorizer === undefined && isPlainData(options);
}

// `open(options)` makes the real connection; it runs once per browser while a
// lease is held. A caller whose connection options differ from the shared
// connection's (dialogPolicy included) gets a connection of its own rather
// than someone else's storage root or dialog policy.
export async function acquireSharedConnection(
  webSocketDebuggerUrl,
  options,
  { open, timeoutMs },
) {
  if (!canShareConnection(options)) return open(options);
  let entry = shared.get(webSocketDebuggerUrl);
  if (entry && !isDeepStrictEqual(entry.options, options)) return open(options);
  if (!entry) {
    entry = { options, refs: 0, ready: open(options) };
    shared.set(webSocketDebuggerUrl, entry);
  }
  entry.refs += 1;
  try {
    const connection = await entry.ready;
    // A dropped socket is already being reconnected by the client; join that
    // attempt (or start one) instead of opening a second connection.
    const reconnected = connection.cdp.ensureConnected();
    await (timeoutMs === undefined
      ? reconnected
      : withinTimeout(
          reconnected,
          timeoutMs,
          `timed out after ${timeoutMs}ms reconnecting the CDP session on ${webSocketDebuggerUrl}`,
        ));
    return lease(webSocketDebuggerUrl, entry, connection);
  } catch (error) {
    // The browser behind this key is gone or unreachable: evict the entry so
    // the next attach resolves and opens anew instead of joining a dead one.
    if (shared.get(webSocketDebuggerUrl) === entry) shared.delete(webSocketDebuggerUrl);
    await release(webSocketDebuggerUrl, entry);
    throw error;
  }
}
