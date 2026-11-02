import { watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

// fs.watch can drop or delay directory events on a loaded host (seconds, or
// never), so the file is also re-read on this interval until the launch settles.
const ACTIVE_PORT_POLL_MS = 100;

function httpEndpointFromWebSocket(webSocketUrl) {
  const endpoint = new URL(webSocketUrl);
  endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
  endpoint.pathname = "/";
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint.toString().replace(/\/$/, "");
}

// Chromium writes `<port>\n/devtools/browser/<guid>`; the second line names the browser.
function parseActivePort(text) {
  const [portLine, browserPath] = text.trim().split(/\r?\n/);
  const port = Number(portLine);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    browserPath: browserPath?.trim() || null,
  };
}

function activePortIdentity(info) {
  return { ino: info.ino, mtimeMs: info.mtimeMs, size: info.size };
}

// A DevToolsActivePort that is already there before the spawn was written by
// an earlier run or by another browser on the same profile (#74). Taken before
// the spawn, so discovery can tell it from the file the new browser writes.
export async function snapshotActivePort(profileDir) {
  if (!profileDir) return null;
  try {
    return activePortIdentity(
      await stat(path.join(profileDir, "DevToolsActivePort")),
    );
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function isSameFile(info, previous) {
  return (
    previous !== null &&
    info.ino === previous.ino &&
    info.mtimeMs === previous.mtimeMs &&
    info.size === previous.size
  );
}

// The endpoint is the launched browser's only if it answers with the browser id
// that browser reported, and the browser is still the one we spawned.
export function assertLaunchedBrowser(child, report, webSocketDebuggerUrl) {
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(
      `browser exited before its DevTools endpoint ${report.endpoint} could be verified`,
    );
  }
  const answered = new URL(webSocketDebuggerUrl).pathname;
  if (report.browserPath === null || answered !== report.browserPath) {
    throw new Error(
      `DevTools endpoint ${report.endpoint} answers as ${answered}, not as the launched browser (${report.browserPath ?? "no browser id reported"})`,
    );
  }
}

export async function discoverLaunchedEndpoint(
  child,
  { profileDir, timeoutMs, previousActivePort = null } = {},
) {
  const activePortPath = profileDir
    ? path.join(profileDir, "DevToolsActivePort")
    : null;

  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = "";
    let activePortWatcher;
    let activePortReading = false;
    let activePortChangedWhileReading = false;
    const cleanups = [];

    const finish = (error, endpoint) => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanups.splice(0)) cleanup();
      activePortWatcher?.close();
      if (error) reject(error);
      else resolve(endpoint);
    };

    const readActivePort = async () => {
      const info = await stat(activePortPath);
      if (isSameFile(activePortIdentity(info), previousActivePort)) return;
      const report = parseActivePort(await readFile(activePortPath, "utf8"));
      if (report) finish(null, report);
    };

    const tryActivePort = async () => {
      if (!activePortPath || settled) return;
      if (activePortReading) {
        activePortChangedWhileReading = true;
        return;
      }
      activePortReading = true;
      try {
        do {
          activePortChangedWhileReading = false;
          await readActivePort();
        } while (activePortChangedWhileReading && !settled);
      } catch (error) {
        if (error?.code !== "ENOENT") finish(error);
      } finally {
        activePortReading = false;
      }
    };

    const onStderr = (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (match) {
        finish(null, {
          endpoint: httpEndpointFromWebSocket(match[1]),
          browserPath: new URL(match[1]).pathname,
        });
      }
      else void tryActivePort();
    };
    const onError = (error) => finish(error);
    const onExit = (code, signal) => {
      finish(
        new Error(
          `browser exited before exposing DevTools (code ${code}, signal ${signal ?? "none"})${stderr ? `\n${stderr}` : ""}`,
        ),
      );
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
    cleanups.push(() => child.stderr.off("data", onStderr));
    cleanups.push(() => child.off("error", onError));
    cleanups.push(() => child.off("exit", onExit));

    if (activePortPath) {
      try {
        activePortWatcher = watch(profileDir, (event, filename) => {
          if (
            (event === "rename" || event === "change") &&
            (!filename ||
              filename.toString() === path.basename(activePortPath))
          ) {
            void tryActivePort();
          }
        });
      } catch (error) {
        if (error?.code !== "ENOENT") finish(error);
      }
      void tryActivePort();
      const poll = setInterval(() => void tryActivePort(), ACTIVE_PORT_POLL_MS);
      cleanups.push(() => clearInterval(poll));
    }

    const timeout = setTimeout(() => {
      finish(
        new Error(
          `browser did not expose a DevTools endpoint within ${timeoutMs}ms${stderr ? `\n${stderr}` : ""}`,
        ),
      );
    }, timeoutMs);
    cleanups.push(() => clearTimeout(timeout));
  });
}
