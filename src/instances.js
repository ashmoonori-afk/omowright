import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { profileDirFromArgs, terminateChild } from "./browser-process.js";
import { openConnection } from "./connection.js";
import { isPidAlive, unlinkIfPresent, withLock } from "./instance-lock.js";
import {
  assertLaunchedBrowser,
  discoverLaunchedEndpoint,
  snapshotActivePort,
} from "./launch-endpoint.js";
import { acquireSharedConnection } from "./shared-connections.js";

const RECORD_VERSION = 2;
const DEFAULT_REGISTRY_ROOT = path.join(
  os.homedir(),
  ".local",
  "share",
  "omowright",
  "instances",
);
const DEFAULT_PROBE_TIMEOUT_MS = 1_000;
const DEFAULT_LAUNCH_TIMEOUT_MS = 10_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
// Waiting for the lock has to outlast the slowest honest critical section
// (probe + launch + CDP attach); a shorter budget makes a second caller give up
// at the exact moment the first one is about to publish its record.
const LOCK_TIMEOUT_MARGIN_MS = 5_000;
// Same sum the per-call resolver below computes, for callers with no overrides.
const DEFAULT_LOCK_TIMEOUT_MS = resolveLockTimeoutMs({});
// A lock whose content never became readable counts as held until it is older
// than any legitimate hold: an unreadable lock is far more likely to be a
// contender caught mid-acquire than an abandoned file.
const STALE_LOCK_GRACE_MS = DEFAULT_LOCK_TIMEOUT_MS;

function normalizeName(name) {
  if (
    typeof name !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
  ) {
    throw new TypeError(
      "instance name must start with a letter or number and contain only letters, numbers, dots, dashes, or underscores",
    );
  }
  return name;
}

function registryPaths(registryRoot, name) {
  const root = path.resolve(registryRoot ?? DEFAULT_REGISTRY_ROOT);
  return {
    root,
    recordPath: path.join(root, `${name}.json`),
    lockPath: path.join(root, `${name}.lock`),
  };
}

async function ensureRegistryRoot(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
}

function isRecord(value, expectedName) {
  return (
    value !== null &&
    typeof value === "object" &&
    value.version === RECORD_VERSION &&
    value.name === expectedName &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.endpoint === "string" &&
    value.endpoint.length > 0 &&
    typeof value.webSocketDebuggerUrl === "string" &&
    value.webSocketDebuggerUrl.length > 0 &&
    (typeof value.profileDir === "string" || value.profileDir === null) &&
    typeof value.browserPath === "string" &&
    value.browserPath.length > 0 &&
    typeof value.startedAt === "string" &&
    !Number.isNaN(Date.parse(value.startedAt))
  );
}

async function readRecord(recordPath, expectedName) {
  let text;
  try {
    text = await readFile(recordPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, record: null };
    throw error;
  }

  try {
    const record = JSON.parse(text);
    return {
      exists: true,
      record: isRecord(record, expectedName) ? record : null,
    };
  } catch {
    return { exists: true, record: null };
  }
}

async function writeRecordAtomic(root, recordPath, record) {
  const tempPath = path.join(
    root,
    `.${record.name}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.close();
    handle = null;
    await chmod(tempPath, 0o600);
    await rename(tempPath, recordPath);
    await chmod(recordPath, 0o600);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

function isConnectionRefused(error) {
  for (let cause = error; cause; cause = cause?.cause) {
    if (
      cause.code === "ECONNREFUSED" ||
      cause.code === "ENOTFOUND" ||
      // Bun's fetch reports refused connections with this code.
      cause.code === "ConnectionRefused"
    ) {
      return true;
    }
  }
  return false;
}

async function probeEndpoint(endpoint, timeoutMs) {
  const versionUrl = new URL("/json/version", endpoint);
  const response = await fetch(versionUrl, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      `CDP discovery request failed (${response.status} ${response.statusText})`,
    );
  }
  const version = await response.json();
  if (
    typeof version?.webSocketDebuggerUrl !== "string" ||
    version.webSocketDebuggerUrl.length === 0
  ) {
    throw new Error("CDP discovery response lacks webSocketDebuggerUrl");
  }
  return version;
}

function resolveConnectTimeoutMs(options) {
  return options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
}

function resolveLockTimeoutMs(options) {
  if (options.lockTimeoutMs !== undefined) return options.lockTimeoutMs;
  return (
    (options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS) +
    (options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS) +
    resolveConnectTimeoutMs(options) +
    LOCK_TIMEOUT_MARGIN_MS
  );
}

function nameLockOptions(options) {
  return {
    timeoutMs: resolveLockTimeoutMs(options),
    staleGraceMs: STALE_LOCK_GRACE_MS,
  };
}

// `/json/version` answering proves nothing about the WebSocket upgrade behind
// it, so the session handshake carries its own bound.
async function connectWithin(endpoint, options, timeoutMs) {
  const pending = openConnection(endpoint, options);
  let timer;
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `timed out after ${timeoutMs}ms opening a CDP session on ${endpoint}`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    // A session that lands after the bound would otherwise hold a live socket.
    pending.then(
      (connection) => connection.close().catch(() => {}),
      () => {},
    );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function removeOwnedRecord(recordPath, name, pid) {
  const loaded = await readRecord(recordPath, name);
  if (loaded.record?.pid !== pid) return;
  await unlinkIfPresent(recordPath);
}

function connectionOptions(options, profileDir) {
  const result = { ...(options.connectionOptions ?? {}) };
  if (options.storageRoot !== undefined) result.storageRoot = options.storageRoot;
  else if (result.storageRoot === undefined && profileDir) {
    result.storageRoot = profileDir;
  }
  if (options.client !== undefined) {
    result.client = {
      ...(result.client ?? {}),
      ...options.client,
    };
  }
  // Part of the sharing key too: callers asking for different dialog policies
  // never share one connection.
  if (options.dialogPolicy !== undefined) result.dialogPolicy = options.dialogPolicy;
  return result;
}

async function launchNamed(
  name,
  { root, recordPath, lockPath },
  options,
) {
  if (typeof options.browserPath !== "string" || options.browserPath.length === 0) {
    throw new TypeError(
      `connectNamed("${name}") requires browserPath when no healthy instance is registered`,
    );
  }
  const browserArgs = [...(options.browserArgs ?? [])];
  const profileDir = options.profileDir
    ? path.resolve(options.profileDir)
    : profileDirFromArgs(browserArgs);
  const previousActivePort = await snapshotActivePort(profileDir);
  const child = spawn(
    options.browserPath,
    [
      ...browserArgs,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
    ],
    {
      // A named browser is shared through the registry, so it has to outlive
      // the process that launched it. On Windows libuv puts every non-detached
      // child in a kill-on-close job object, which kills the browser the
      // moment its launcher exits (#90); detached keeps it out of that job,
      // and windowsHide keeps a console-subsystem browser from opening a window.
      ...(process.platform === "win32" ? { detached: true, windowsHide: true } : {}),
      ...(options.spawnOptions ?? {}),
      stdio: ["ignore", "ignore", "pipe"],
    },
  );

  let connection;
  try {
    const launchTimeoutMs = options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
    const report = await discoverLaunchedEndpoint(child, {
      profileDir,
      timeoutMs: launchTimeoutMs,
      previousActivePort,
    });
    const { endpoint } = report;
    // The browser's own WebSocket URL carries its GUID: recording it makes a
    // later attach prove it reached this browser and not whatever else ends up
    // on the port once this pid is gone.
    const { webSocketDebuggerUrl } = await probeEndpoint(
      endpoint,
      launchTimeoutMs,
    );
    assertLaunchedBrowser(child, report, webSocketDebuggerUrl);
    connection = await connectWithin(
      endpoint,
      connectionOptions(options, profileDir),
      resolveConnectTimeoutMs(options),
    );
    const record = {
      version: RECORD_VERSION,
      name,
      pid: child.pid,
      endpoint,
      webSocketDebuggerUrl,
      profileDir,
      browserPath: path.resolve(options.browserPath),
      startedAt: new Date().toISOString(),
    };
    await writeRecordAtomic(root, recordPath, record);
    connection.browserProcess = child;
    const disconnect = connection.close.bind(connection);
    connection.close = async () => {
      let failure;
      try {
        await disconnect();
      } catch (error) {
        failure = error;
      }
      await terminateChild(child);
      // The browser this record points at is gone, so the record goes with it
      // instead of waiting for the next caller to clean it up.
      try {
        await withLock(lockPath, nameLockOptions(options), () =>
          removeOwnedRecord(recordPath, name, child.pid),
        );
      } catch (error) {
        failure ??= error;
      }
      if (failure) throw failure;
    };
    return connection;
  } catch (error) {
    await connection?.close().catch(() => {});
    await terminateChild(child);
    throw error;
  }
}

export async function withEngineLock(registryRoot, engineKey, run) {
  const root = path.resolve(registryRoot ?? DEFAULT_REGISTRY_ROOT);
  await ensureRegistryRoot(root);
  const digest = createHash("sha256")
    .update(path.resolve(engineKey))
    .digest("hex")
    .slice(0, 16);
  const lockPath = path.join(root, `_engine-${digest}.lock`);
  return withLock(
    lockPath,
    { timeoutMs: DEFAULT_LOCK_TIMEOUT_MS, staleGraceMs: STALE_LOCK_GRACE_MS },
    run,
  );
}

export async function connectNamed(name, options = {}) {
  const normalizedName = normalizeName(name);
  const paths = registryPaths(options.registryRoot, normalizedName);
  await ensureRegistryRoot(paths.root);
  return withLock(paths.lockPath, nameLockOptions(options), () =>
    attachOrLaunch(normalizedName, paths, options),
  );
}

async function attachOrLaunch(normalizedName, paths, options) {
  const loaded = await readRecord(paths.recordPath, normalizedName);
  if (loaded.record) {
    await chmod(paths.recordPath, 0o600);
    if (isPidAlive(loaded.record.pid)) {
      let version = null;
      try {
        version = await probeEndpoint(
          loaded.record.endpoint,
          options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
        );
      } catch (error) {
        if (!isConnectionRefused(error)) {
          throw new Error(
            `unresponsive holder "${normalizedName}" pid ${loaded.record.pid} endpoint ${loaded.record.endpoint}: ${error.message}`,
            { cause: error },
          );
        }
        // A live pid whose recorded debug port refuses connections is a
        // reused pid, not a holder: the record is stale and the launch
        // below reclaims it.
      }
      // A pid that came back and a port any local process can rebind are
      // not an identity. Only the recorded WebSocket URL (it carries the
      // browser GUID) says this is our browser; anything else answering
      // there is a stranger, so the record is stale, not a holder.
      if (
        version?.webSocketDebuggerUrl === loaded.record.webSocketDebuggerUrl
      ) {
        // Connecting to the recorded GUID URL, not the port, keeps the shared
        // connection's auto-reconnect from landing on a different browser.
        const { webSocketDebuggerUrl } = loaded.record;
        const timeoutMs = resolveConnectTimeoutMs(options);
        try {
          return await acquireSharedConnection(
            webSocketDebuggerUrl,
            connectionOptions(options, loaded.record.profileDir),
            {
              open: (shared) =>
                connectWithin(webSocketDebuggerUrl, shared, timeoutMs),
              timeoutMs,
            },
          );
        } catch (error) {
          throw new Error(
            `unresponsive holder "${normalizedName}" pid ${loaded.record.pid} endpoint ${loaded.record.endpoint}: ${error.message}`,
            { cause: error },
          );
        }
      }
    }
  }

  if (loaded.exists) {
    await unlink(paths.recordPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  return await launchNamed(normalizedName, paths, options);
}

export async function listInstances(options = {}) {
  const root = path.resolve(options.registryRoot ?? DEFAULT_REGISTRY_ROOT);
  await ensureRegistryRoot(root);
  const entries = await readdir(root, { withFileTypes: true });
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const expectedName = entry.name.slice(0, -".json".length);
        const recordPath = path.join(root, entry.name);
        const loaded = await readRecord(recordPath, expectedName);
        if (!loaded.record) return null;
        await chmod(recordPath, 0o600);
        const alive = isPidAlive(loaded.record.pid);
        let responsive = false;
        if (alive) {
          responsive = await probeEndpoint(
            loaded.record.endpoint,
            options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
          ).then(
            (version) =>
              version.webSocketDebuggerUrl === loaded.record.webSocketDebuggerUrl,
            () => false,
          );
        }
        return { ...loaded.record, alive, responsive };
      }),
  );
  return records
    .filter((record) => record !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}
