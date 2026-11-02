// Contract owner: one approved CDP connection per browser per process, for both
// attach paths: connectNamed (#68) and connect(url) (#76).
// Chrome asks the user to allow remote debugging once per WebSocket connection
// to their own profile, so every extra upgrade is an extra prompt. The fake
// endpoint below counts upgrades at the real HTTP/WebSocket attach boundary.
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { connect } from "../src/connection.js";
import { connectNamed } from "../src/instances.js";
import * as sharedConnections from "../src/shared-connections.js";

// A browser that answers discovery with its current GUID and, like Chrome,
// only upgrades the WebSocket path of that GUID.
async function fakeCdpEndpoint() {
  let guid = "first";
  const upgrades = [];
  const authorizations = [];
  const sockets = new Set();
  // Each socket's id is its upgrade order; answers records how every socket
  // answered the dialogs emitDialog() raised on it.
  const socketIds = new Map();
  const answers = [];
  const answered = new EventEmitter();
  const server = createServer((request, response) => {
    const body = request.url === "/json/version"
      ? { Browser: "FakeChrome/1.0", webSocketDebuggerUrl: webSocketUrl() }
      : request.url === "/json/list" ? [] : null;
    if (!body) return void response.writeHead(404).end();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  const webSockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== `/devtools/browser/${guid}`) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      socketIds.set(webSocket, upgrades.length);
      upgrades.push(guid);
      authorizations.push(request.headers.authorization ?? null);
      sockets.add(webSocket);
      webSocket.on("close", () => sockets.delete(webSocket));
      webSocket.on("message", (data) => {
        const { id, method, params } = JSON.parse(data.toString());
        if (method === "Page.handleJavaScriptDialog") {
          answers.push({ socket: socketIds.get(webSocket), accept: params.accept });
          answered.emit("answer");
        }
        webSocket.send(JSON.stringify({ id, result: {} }));
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  function webSocketUrl() {
    return `${endpoint.replace(/^http/, "ws")}/devtools/browser/${guid}`;
  }
  return {
    endpoint,
    upgrades,
    authorizations,
    sockets,
    answers,
    webSocketUrl,
    // One CDP event pushed down every open socket.
    emitEvent(method, params = {}) {
      for (const webSocket of sockets) webSocket.send(JSON.stringify({ method, params }));
    },
    // One confirm() on every open socket; resolves once each has answered.
    async dialogOnEverySocket() {
      const expected = answers.length + sockets.size;
      const done = new Promise((resolve) => {
        const check = () => {
          if (answers.length < expected) return;
          answered.off("answer", check);
          resolve(answers.slice(expected - sockets.size));
        };
        answered.on("answer", check);
      });
      for (const webSocket of sockets) {
        webSocket.send(JSON.stringify({
          method: "Page.javascriptDialogOpening",
          sessionId: "dialog-session",
          params: { type: "confirm", message: "Leave?", url: "about:blank" },
        }));
      }
      return done;
    },
    // The browser behind the port is now another one. Open sockets are kept,
    // so a stale cached connection is still alive when the lookup happens.
    becomeBrowser(nextGuid) {
      guid = nextGuid;
    },
    dropConnections() {
      for (const webSocket of sockets) webSocket.terminate();
    },
    async close() {
      for (const webSocket of sockets) webSocket.terminate();
      webSockets.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function register(registryRoot, name, fake) {
  await mkdir(registryRoot, { recursive: true, mode: 0o700 });
  const record = {
    version: 2,
    name,
    // This process stands in for the browser pid: alive for the whole test.
    pid: process.pid,
    endpoint: fake.endpoint,
    webSocketDebuggerUrl: fake.webSocketUrl(),
    profileDir: null,
    browserPath: process.execPath,
    startedAt: new Date().toISOString(),
  };
  await writeFile(
    path.join(registryRoot, `${name}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function nextTransportEvent(connection, name) {
  return new Promise((resolve) => {
    const off = connection.cdp.transportEvents.on(name, () => {
      off();
      resolve();
    });
  });
}

// Both attach paths run every case below. A named attach finds the browser
// through its registry record (re-registered when the browser changes); a URL
// attach finds it through the endpoint's /json/version.
const attachPaths = [
  {
    label: "connectNamed",
    attach: ({ registryRoot }, options = {}) => connectNamed("mine", { registryRoot, ...options }),
    browserChanged: ({ registryRoot, fake }) => register(registryRoot, "mine", fake),
  },
  {
    label: "connect(url)",
    attach: ({ fake }, options) => connect(fake.endpoint, options),
    browserChanged: async () => {},
  },
];

async function withFakeBrowser(attachPath, run) {
  const registryRoot = await mkdtemp(path.join(tmpdir(), "omowright-shared-"));
  const fake = await fakeCdpEndpoint();
  const connections = [];
  const context = { fake, registryRoot };
  const attach = async (options) => {
    const connection = await attachPath.attach(context, options);
    connections.push(connection);
    return connection;
  };
  try {
    await register(registryRoot, "mine", fake);
    await run({ ...context, attach, browserChanged: () => attachPath.browserChanged(context) });
  } finally {
    await Promise.all(connections.map((c) => c.close().catch(() => {})));
    await fake.close();
    await rm(registryRoot, { recursive: true, force: true });
  }
}

for (const attachPath of attachPaths) {
  test(`repeated ${attachPath.label} calls reuse one connection until the last close`, async () => {
    await withFakeBrowser(attachPath, async ({ fake, attach }) => {
      const first = await attach();
      const second = await attach();
      const third = await attach();
      assert.deepEqual(fake.upgrades, ["first"]);

      // A caller's close releases its handle; the others keep the connection.
      await first.close();
      await second.close();
      await third.cdp.send("Browser.getVersion");
      assert.equal(fake.sockets.size, 1);

      // The last release disconnects, so a script that closes can still exit.
      const [socket] = fake.sockets;
      const closed = once(socket, "close");
      await third.close();
      await closed;
      assert.deepEqual(fake.upgrades, ["first"]);
    });
  });

  test(`concurrent first ${attachPath.label} calls share one upgrade`, async () => {
    await withFakeBrowser(attachPath, async ({ fake, attach }) => {
      await Promise.all([attach(), attach(), attach()]);
      assert.deepEqual(fake.upgrades, ["first"]);
    });
  });

  test(`a dropped ${attachPath.label} connection is replaced by exactly one new upgrade`, async () => {
    await withFakeBrowser(attachPath, async ({ fake, attach }) => {
      const first = await attach();
      const dropped = nextTransportEvent(first, "disconnected");
      const restored = nextTransportEvent(first, "reconnected");
      fake.dropConnections();
      await dropped;

      const next = await attach();
      await restored;
      await next.cdp.send("Browser.getVersion");
      await first.cdp.send("Browser.getVersion");
      assert.deepEqual(fake.upgrades, ["first", "first"]);
    });
  });

  test(`${attachPath.label} never reuses a connection for a different browser GUID at the same port`, async () => {
    await withFakeBrowser(attachPath, async ({ fake, attach, browserChanged }) => {
      const old = await attach();
      fake.becomeBrowser("second");
      await browserChanged();

      const fresh = await attach();
      assert.notEqual(fresh.cdp, old.cdp);
      await fresh.cdp.send("Browser.getVersion");
      assert.deepEqual(fake.upgrades, ["first", "second"]);
    });
  });
}

// connect(url) leases are keyed by the browser GUID, so the connection behind a
// key must never end up serving another browser (#79 review). Short reconnect
// delays keep the doomed reconnects to the vanished GUID quick.
test("connect(url) never leases a connection that would serve a different browser", async () => {
  await withFakeBrowser(attachPaths[1], async ({ fake }) => {
    const options = { client: { reconnectDelaysMs: [0, 50] } };
    const oldUrl = fake.webSocketUrl();
    const first = await connect(fake.endpoint, options);
    let stale;
    let fresh;
    try {
      const dropped = nextTransportEvent(first, "disconnected");
      fake.becomeBrowser("second");
      fake.dropConnections();
      await dropped;

      const error = await connect(oldUrl, options).then((attached) => {
        stale = attached;
        return null;
      }, (rejection) => rejection);
      assert.ok(error instanceof Error, "an attach to the vanished browser must fail, not lease");
      assert.deepEqual(fake.upgrades, ["first"]);

      // The failed entry is evicted, so the endpoint resolves anew.
      fresh = await connect(fake.endpoint, options);
      await fresh.cdp.send("Browser.getVersion");
      assert.deepEqual(fake.upgrades, ["first", "second"]);
    } finally {
      await Promise.all([first, stale, fresh].map((c) => c?.close().catch(() => {})));
    }
  });
});

// Security contract (#79 review): an authorizer is a credential, and two of them
// can hide different tokens behind equal-looking objects. Each caller gets its
// own connection, authorized with its own token.
test("connect(url) never shares one connection across two authorizers", async () => {
  class TokenAuthorizer {
    #token;
    constructor(token) {
      this.#token = token;
    }
    async resolveAuthorization() {
      return `Bearer ${this.#token}`;
    }
  }
  await withFakeBrowser(attachPaths[1], async ({ fake }) => {
    const a = await connect(fake.endpoint, { client: { authorizer: new TokenAuthorizer("thread-a") } });
    const b = await connect(fake.endpoint, { client: { authorizer: new TokenAuthorizer("thread-b") } });
    try {
      assert.notEqual(a.cdp, b.cdp);
      assert.deepEqual(fake.authorizations, ["Bearer thread-a", "Bearer thread-b"]);
    } finally {
      await Promise.all([a, b].map((c) => c.close().catch(() => {})));
    }
  });
});

// Contract owner: a handle never changes what another holder gets (#72 review).
// The shared connection's dialog policy, client, properties and listeners are
// what every other holder and every later attach sees. Socket 0 is the first
// connection in every row; dialogs are raised on every open socket.
const sharedPolicyPaths = [
  { label: "the handle", set: (handle, policy) => handle.setDialogPolicy(policy) },
  { label: "the handle's cdp", set: (handle, policy) => handle.cdp.setDialogPolicy(policy) },
];
const byDialogSocket = (answers) => answers.sort((x, y) => x.socket - y.socket).map((a) => a.accept);
const holderCases = [
  ...sharedPolicyPaths.map((path) => ({
    label: `setDialogPolicy through ${path.label} on a shared connection throws SharedConnectionError`,
    async run({ fake, connectAs }) {
      const changing = await connectAs();
      await connectAs();
      assert.throws(() => path.set(changing, { accept: false }), (error) => {
        assert.equal(error?.name, "SharedConnectionError");
        assert.ok(error instanceof sharedConnections.SharedConnectionError);
        assert.equal(error.code, "shared_connection");
        assert.match(error.message, /pass dialogPolicy to connect\(\)\/connectNamed\(\)/);
        return true;
      });
      assert.deepEqual(byDialogSocket(await fake.dialogOnEverySocket()), [true]);
      assert.deepEqual(fake.upgrades, ["first"]);
    },
  })),
  ...sharedPolicyPaths.map((path) => ({
    label: `a sole holder's setDialogPolicy through ${path.label} works and stops sharing`,
    async run({ fake, connectAs }) {
      const sole = await connectAs();
      path.set(sole, { accept: false });
      await connectAs();
      assert.deepEqual(byDialogSocket(await fake.dialogOnEverySocket()), [false, true]);
    },
  })),
  ...sharedPolicyPaths.map((path) => ({
    label: `setDialogPolicy(undefined) through ${path.label} resets to accepting dialogs`,
    async run({ fake, connectAs }) {
      const sole = await connectAs({ dialogPolicy: { accept: false } });
      path.set(sole, undefined);
      assert.deepEqual(byDialogSocket(await fake.dialogOnEverySocket()), [true]);
    },
  })),
  {
    label: "attaches asking for different dialog policies never share",
    async run({ fake, connectAs }) {
      await connectAs({ dialogPolicy: { accept: false } });
      await connectAs();
      assert.deepEqual(fake.upgrades, ["first", "first"]);
      assert.deepEqual(byDialogSocket(await fake.dialogOnEverySocket()), [false, true]);
    },
  },
  {
    label: "a property set or defined on a handle stays on that handle",
    async run({ connectAs }) {
      const writer = await connectAs();
      const other = await connectAs();
      writer.marker = "set";
      Object.defineProperty(writer, "defined", { value: "defined", configurable: true });
      assert.equal(writer.marker, "set");
      assert.equal(writer.defined, "defined");
      assert.equal(other.marker, undefined);
      assert.equal(other.defined, undefined);
    },
  },
  {
    label: "a handle cannot delete a shared property",
    async run({ connectAs }) {
      const deleting = await connectAs();
      const other = await connectAs();
      assert.throws(() => {
        delete deleting.tabs;
      }, TypeError);
      assert.deepEqual(await other.listTargets(), []);
    },
  },
  {
    label: "a client reference taken through a handle cannot change the shared client",
    async run({ fake, connectAs }) {
      const client = (await connectAs()).cdp;
      const other = await connectAs();
      const before = other.cdp.logId;
      assert.throws(() => {
        client.logId = "changed";
      }, TypeError);
      assert.throws(() => Object.defineProperty(client, "logId", { value: "changed" }), TypeError);
      assert.throws(() => {
        delete client.logId;
      }, TypeError);
      assert.equal(other.cdp.logId, before);
      await other.cdp.send("Browser.getVersion");
      assert.deepEqual(fake.upgrades, ["first"]);
    },
  },
  {
    label: "listeners added through a handle stop when that handle closes",
    async run({ fake, connectAs }) {
      const closing = await connectAs();
      const other = await connectAs();
      const heardByClosed = [];
      closing.cdp.on("Target.targetCreated", () => heardByClosed.push("cdp"));
      closing.cdp.transportEvents.on("disconnected", () => heardByClosed.push("transport"));
      await closing.close();
      const delivered = new Promise((resolve) => other.cdp.on("Target.targetCreated", resolve));
      const dropped = nextTransportEvent(other, "disconnected");
      fake.emitEvent("Target.targetCreated", { targetInfo: { targetId: "t", type: "page" } });
      await delivered;
      fake.dropConnections();
      await dropped;
      assert.deepEqual(heardByClosed, []);
    },
  },
  {
    label: "cdp.close() on a handle releases only that handle",
    async run({ fake, connectAs }) {
      const closing = await connectAs();
      const other = await connectAs();
      await closing.cdp.close();
      await other.cdp.send("Browser.getVersion");
      assert.deepEqual(fake.upgrades, ["first"]);
      assert.equal(fake.sockets.size, 1);
    },
  },
  {
    label: "a closed handle refuses further use",
    async run({ fake, connectAs }) {
      const closed = await connectAs();
      await connectAs();
      await closed.close();
      assert.throws(() => closed.listTargets(), /handle was closed/);
      assert.throws(() => closed.cdp, /handle was closed/);
      assert.deepEqual(fake.upgrades, ["first"]);
    },
  },
  {
    label: "clearListeners through a handle removes only that handle's transport listeners",
    async run({ fake, connectAs }) {
      const clearing = await connectAs();
      const other = await connectAs();
      const heard = [];
      clearing.cdp.transportEvents.on("disconnected", () => heard.push("clearing"));
      other.cdp.transportEvents.on("disconnected", () => heard.push("other"));
      clearing.cdp.transportEvents.clearListeners();
      const dropped = nextTransportEvent(other, "disconnected");
      fake.dropConnections();
      await dropped;
      assert.deepEqual(heard, ["other"]);
    },
  },
  {
    label: "emit through a handle is refused",
    async run({ connectAs }) {
      const emitting = await connectAs();
      const other = await connectAs();
      const heard = [];
      other.cdp.transportEvents.on("disconnected", () => heard.push("other"));
      assert.throws(() => emitting.cdp.transportEvents.emit("disconnected"), TypeError);
      assert.deepEqual(heard, []);
    },
  },
  {
    label: "a handle's reserved members cannot be replaced",
    async run({ connectAs }) {
      const handle = await connectAs();
      for (const member of ["cdp", "close", "setDialogPolicy"]) {
        assert.throws(() => {
          handle[member] = () => {};
        }, TypeError, member);
        assert.throws(() => Object.defineProperty(handle, member, { value: 1, configurable: true }), TypeError, member);
      }
    },
  },
  {
    label: "a handle's own keys and descriptors show what was set on it",
    async run({ connectAs }) {
      const writer = await connectAs();
      const other = await connectAs();
      writer.marker = "set";
      assert.ok(Object.keys(writer).includes("marker"));
      assert.equal(Object.getOwnPropertyDescriptor(writer, "marker")?.value, "set");
      assert.ok(!Object.keys(other).includes("marker"));
      assert.equal(Object.getOwnPropertyDescriptor(other, "marker"), undefined);
    },
  },
];

for (const attachPath of attachPaths) {
  for (const holderCase of holderCases) {
    test(`${attachPath.label}: ${holderCase.label}`, async () => {
      await withFakeBrowser(attachPath, ({ fake, attach }) =>
        holderCase.run({ fake, connectAs: (options) => attach(options) }));
    });
  }
}

// Options are shared only when equality can see all of them (#79 review): a
// cycle must not throw, and a symbol or non-enumerable key, or an accessor, can
// hide a difference (a non-enumerable dialogPolicy is still read when the
// connection is made), so each of these gets a connection of its own.
const unshareableOptions = [
  {
    label: "cyclic options",
    make: () => {
      const options = { client: {} };
      options.client.owner = options;
      return options;
    },
  },
  {
    label: "a non-enumerable dialogPolicy",
    make: () => Object.defineProperty({}, "dialogPolicy", { value: { accept: false }, enumerable: false }),
  },
  { label: "a symbol key", make: () => ({ [Symbol.for("omowright.test")]: true }) },
  { label: "an accessor", make: () => ({ get storageRoot() { return "."; } }) },
];
for (const unshareable of unshareableOptions) {
  test(`connect(url) with ${unshareable.label} gets a connection of its own`, async () => {
    await withFakeBrowser(attachPaths[1], async ({ fake }) => {
      const handles = [];
      try {
        handles.push(await connect(fake.endpoint, unshareable.make()));
        handles.push(await connect(fake.endpoint, unshareable.make()));
        assert.notEqual(handles[0].cdp, handles[1].cdp);
        assert.deepEqual(fake.upgrades, ["first", "first"]);
      } finally {
        await Promise.all(handles.map((h) => h.close().catch(() => {})));
      }
    });
  });
}
