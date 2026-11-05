import { appendFileSync, closeSync, openSync, writeSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";

// FAKE_SIGNAL_LOG names a file that receives "CLOSE <epoch ms>" for each
// Browser.close and "TERM <epoch ms>" for SIGTERM. Like Chrome it quits after
// answering Browser.close; FAKE_ON_CLOSE=ignore keeps it running.
const signalLog = process.env.FAKE_SIGNAL_LOG;
const record = (event) => {
  if (signalLog) appendFileSync(signalLog, `${event} ${Date.now()}\n`);
};

const target = {
  description: "",
  id: "fake-page",
  title: "Fake named browser",
  type: "page",
  url: "about:blank",
};

const server = createServer((req, res) => {
  const port = server.address().port;
  if (req.url === "/json/version") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        Browser: "FakeNamedBrowser/1.0",
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl:
          `ws://127.0.0.1:${port}/devtools/browser/fake`,
      }),
    );
    return;
  }
  if (req.url === "/json/list") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([target]));
    return;
  }
  res.writeHead(404).end();
});

const sockets = new Set();
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

const webSockets = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  webSockets.handleUpgrade(req, socket, head, (webSocket) => {
    webSockets.emit("connection", webSocket, req);
  });
});
webSockets.on("connection", (webSocket) => {
  webSocket.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    if (message.method === "Browser.close") {
      record("CLOSE");
      const reply = JSON.stringify({ id: message.id, result: {} });
      if (process.env.FAKE_ON_CLOSE === "ignore") webSocket.send(reply);
      else if (process.env.FAKE_ON_CLOSE === "delayed") {
        // Model asynchronous browser cleanup after acknowledging the request.
        // On Windows terminateChild itself grants 5 s after Browser.close.
        // Cleanup at 6 s needs the named close's additional 2 s window too.
        webSocket.send(reply, () => setTimeout(shutdown, process.platform === "win32" ? 6_000 : 250));
      } else webSocket.send(reply, shutdown);
      return;
    }
    const result = message.method === "Browser.getVersion"
      ? { product: "FakeNamedBrowser/1.0", protocolVersion: "1.3" }
      : {};
    webSocket.send(JSON.stringify({ id: message.id, result }));
  });
});

function shutdown() {
  for (const webSocket of webSockets.clients) webSocket.terminate();
  for (const socket of sockets) socket.destroy();
  webSockets.close();
  server.close(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", () => {
  record("TERM");
  shutdown();
});

function flag(name) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

// Like Chromium: DevToolsActivePort in the user data dir, then the stderr line.
// --fake-quiet drops the stderr line (chrome.exe on Windows has none), and
// --fake-active-port writes another port, as a second browser on the dir would.
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const userDataDir = flag("user-data-dir");
  if (userDataDir) {
    // Truncated at open, then written, as Chromium does. bun's writeFileSync
    // rewrites an existing file in place on Linux, which lets a concurrent
    // reader see the new bytes over the old file's tail (#107).
    const fd = openSync(path.join(userDataDir, "DevToolsActivePort"), "w");
    try {
      writeSync(fd, `${flag("fake-active-port") ?? port}\n/devtools/browser/fake`);
    } finally {
      closeSync(fd);
    }
  }
  if (!process.argv.includes("--fake-quiet")) {
    process.stderr.write(
      `DevTools listening on ws://127.0.0.1:${port}/devtools/browser/fake\n`,
    );
  }
});
