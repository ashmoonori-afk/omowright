// Contract owner: the public named-instance registry lifecycle. These tests use
// the real HTTP/WebSocket attach boundary, so stale-state, locking, or record
// regressions fail without adding a production-only seam.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { connectNamed, listInstances } from "../src/instances.js";
import { readEvents } from "./fixtures/browser-lifecycle.mjs";
import { reclaimLock, withLock } from "../src/instance-lock.js";

const fixture = fileURLToPath(
  new URL("./fixtures/fake-named-browser.mjs", import.meta.url),
);
const lockRaceChild = fileURLToPath(
  new URL("./fixtures/named-instance-child.mjs", import.meta.url),
);
const fakeTarget = {
  description: "",
  id: "fake-page",
  title: "Fake named browser",
  type: "page",
  url: "about:blank",
};

function instanceRecord(name, values) {
  return {
    version: 2,
    name,
    pid: values.pid,
    endpoint: values.endpoint,
    // The fixture derives its WebSocket URL from the port it listens on, so
    // the default here is the one a healthy attach has to match.
    webSocketDebuggerUrl:
      values.webSocketDebuggerUrl ??
      `${values.endpoint.replace(/^http/, "ws")}/devtools/browser/fake`,
    profileDir: values.profileDir ?? null,
    browserPath: values.browserPath ?? process.execPath,
    startedAt: values.startedAt ?? new Date().toISOString(),
  };
}

async function writeRecord(registryRoot, name, record) {
  await mkdir(registryRoot, { recursive: true, mode: 0o700 });
  const recordPath = path.join(registryRoot, `${name}.json`);
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
  });
  return recordPath;
}

async function launchFakeBrowser() {
  const child = spawn(
    process.execPath,
    [
      fixture,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  child.stderr.setEncoding("utf8");
  let stderr = "";
  const webSocketDebuggerUrl = await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      stderr += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (!match) return;
      cleanup();
      resolve(match[1]);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(
        new Error(
          `fake browser exited early (code ${code}, signal ${signal ?? "none"})`,
        ),
      );
    };
    const cleanup = () => {
      child.stderr.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.stderr.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
  return {
    child,
    webSocketDebuggerUrl,
    endpoint: webSocketDebuggerUrl
      .replace(/^ws:/, "http:")
      .replace(/\/devtools\/.*$/, ""),
  };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

function deadPid() {
  for (const pid of [2_147_483_647, 1_073_741_823, 536_870_911]) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return pid;
      if (error?.code !== "EPERM") throw error;
    }
  }
  throw new Error("could not find an unused pid for the stale-record test");
}

async function closedEndpoint() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return endpoint;
}

test("connectNamed attaches to a healthy registered browser", async () => {
  const registryRoot = await mkdtemp(
    path.join(tmpdir(), "omowright-instances-"),
  );
  const fake = await launchFakeBrowser();
  let connection;
  try {
    await writeRecord(
      registryRoot,
      "healthy",
      instanceRecord("healthy", {
        pid: fake.child.pid,
        endpoint: fake.endpoint,
      }),
    );

    connection = await connectNamed("healthy", { registryRoot });

    assert.equal(connection.browserProcess, undefined);
    assert.deepEqual(await connection.listTargets(), [fakeTarget]);
    await connection.close();
    connection = null;
    assert.doesNotThrow(() => process.kill(fake.child.pid, 0));
  } finally {
    await connection?.close().catch(() => {});
    await stopChild(fake.child);
    await rm(registryRoot, { recursive: true, force: true });
  }
});

// Contract owner: how a launched named browser is closed. It is asked over CDP
// first (the only quit request Windows has, and the clean quit Chrome needs),
// falls back to the signal path when it does not quit, and a browser that is
// already gone is never asked, so close() cannot ask whatever process holds
// its freed port by then to quit.
function namedLaunchOptions(registryRoot, env) {
  return {
    registryRoot,
    browserPath: process.execPath,
    browserArgs: [fixture],
    spawnOptions: { env: { ...process.env, ...env } },
  };
}

test("closing a launched named browser asks it to quit over CDP", { timeout: 20_000 }, async () => {
  const registryRoot = await mkdtemp(path.join(tmpdir(), "omowright-instances-"));
  const logPath = path.join(registryRoot, "signals.log");
  let connection;
  try {
    connection = await connectNamed("asked", namedLaunchOptions(registryRoot, { FAKE_SIGNAL_LOG: logPath }));
    const child = connection.browserProcess;
    const exit = once(child, "exit");
    await connection.close();
    connection = null;
    const [code, signal] = await exit;
    assert.deepEqual(readEvents(logPath).map(({ event }) => event), ["CLOSE"]);
    assert.deepEqual({ code, signal }, { code: 0, signal: null });
  } finally {
    await connection?.close().catch(() => {});
    await rm(registryRoot, { recursive: true, force: true });
  }
});

test("closing a named browser that ignores Browser.close still ends it", { timeout: 30_000 }, async () => {
  const registryRoot = await mkdtemp(path.join(tmpdir(), "omowright-instances-"));
  const logPath = path.join(registryRoot, "signals.log");
  let connection;
  try {
    connection = await connectNamed(
      "stubborn",
      namedLaunchOptions(registryRoot, { FAKE_SIGNAL_LOG: logPath, FAKE_ON_CLOSE: "ignore" }),
    );
    const child = connection.browserProcess;
    const exit = once(child, "exit");
    await connection.close();
    connection = null;
    await exit;
    const events = readEvents(logPath).map(({ event }) => event);
    // POSIX asks again with SIGTERM; on Windows no signal can ask, so the
    // browser is terminated after the grace window instead.
    assert.deepEqual(events, process.platform === "win32" ? ["CLOSE"] : ["CLOSE", "TERM"]);
  } finally {
    await connection?.close().catch(() => {});
    await rm(registryRoot, { recursive: true, force: true });
  }
});

test("closing a named browser that already died never asks the process on its freed port to quit", { timeout: 20_000 }, async () => {
  const registryRoot = await mkdtemp(path.join(tmpdir(), "omowright-instances-"));
  let connection;
  let stranger;
  let sockets;
  try {
    connection = await connectNamed("gone", namedLaunchOptions(registryRoot, {}));
    const { endpoint } = JSON.parse(await readFile(path.join(registryRoot, "gone.json"), "utf8"));
    const child = connection.browserProcess;
    const exit = once(child, "exit");
    child.kill("SIGKILL");
    await exit;
    // Another process takes the freed port, as any local process may, and
    // answers CDP there. (The client's own background reconnect may reach it;
    // what close() must never do is ask it to quit.)
    const port = Number(new URL(endpoint).port);
    const methods = [];
    stranger = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/stranger` }));
    });
    sockets = new WebSocketServer({ noServer: true });
    stranger.on("upgrade", (req, socket, head) => {
      sockets.handleUpgrade(req, socket, head, (webSocket) => {
        webSocket.on("message", (data) => {
          const message = JSON.parse(data.toString());
          methods.push(message.method);
          webSocket.send(JSON.stringify({ id: message.id, result: {} }));
        });
      });
    });
    stranger.listen(port, "127.0.0.1");
    await once(stranger, "listening");

    await connection.close();
    connection = null;

    assert.equal(methods.includes("Browser.close"), false, `the stranger on the freed port received ${methods.join(", ")}`);
  } finally {
    await connection?.close().catch(() => {});
    for (const client of sockets?.clients ?? []) client.terminate();
    sockets?.close();
    stranger?.closeAllConnections();
    await new Promise((resolve) => (stranger?.listening ? stranger.close(resolve) : resolve()));
    await rm(registryRoot, { recursive: true, force: true });
  }
});

test("connectNamed replaces a dead-pid record with one launched browser", async () => {
  const registryRoot = await mkdtemp(
    path.join(tmpdir(), "omowright-instances-"),
  );
  const profileDir = path.join(registryRoot, "profile");
  const stalePid = deadPid();
  const recordPath = await writeRecord(
    registryRoot,
    "stale",
    instanceRecord("stale", {
      pid: stalePid,
      endpoint: "http://127.0.0.1:1",
      profileDir,
    }),
  );
  let connection;
  try {
    connection = await connectNamed("stale", {
      registryRoot,
      browserPath: process.execPath,
      browserArgs: [fixture],
      profileDir,
    });

    assert.equal(connection.browserProcess?.pid > 0, true);
    const rewritten = JSON.parse(await readFile(recordPath, "utf8"));
    assert.equal(rewritten.version, 2);
    assert.equal(rewritten.name, "stale");
    assert.match(rewritten.webSocketDebuggerUrl, /^ws:\/\/127\.0\.0\.1:\d+\//);
    assert.equal(rewritten.pid, connection.browserProcess.pid);
    assert.notEqual(rewritten.pid, stalePid);
    assert.notEqual(rewritten.endpoint, "http://127.0.0.1:1");
    assert.equal(rewritten.profileDir, profileDir);
    assert.equal(rewritten.browserPath, process.execPath);
    assert.equal((await stat(registryRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(recordPath)).mode & 0o777, 0o600);
    const launchedPid = connection.browserProcess.pid;
    await connection.close();
    connection = null;
    assert.throws(
      () => process.kill(launchedPid, 0),
      (error) => error?.code === "ESRCH",
    );
    // The launcher took its record down with the browser instead of leaving a
    // dead entry for listInstances to report.
    await assert.rejects(
      stat(recordPath),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await connection?.close().catch(() => {});
    await rm(registryRoot, { recursive: true, force: true });
  }
});

test("connectNamed relaunches when a reused pid leaves a refused endpoint", async () => {
  const registryRoot = await mkdtemp(
    path.join(tmpdir(), "omowright-instances-"),
  );
  const endpoint = await closedEndpoint();
  let connection;
  try {
    await writeRecord(
      registryRoot,
      "reused",
      instanceRecord("reused", { pid: process.pid, endpoint }),
    );

    connection = await connectNamed("reused", {
      registryRoot,
      browserPath: process.execPath,
      browserArgs: [fixture],
      probeTimeoutMs: 250,
    });

    // The live pid (this process) was NOT the holder: a fresh browser was
    // launched and the record rewritten to its pid.
    assert.notEqual(connection.browserProcess.pid, process.pid);
    const rewritten = JSON.parse(
      await readFile(path.join(registryRoot, "reused.json"), "utf8"),
    );
    assert.equal(rewritten.pid, connection.browserProcess.pid);
    // Registry hygiene: no lock or temp artifacts survive a completed flow.
    const leftovers = (await readdir(registryRoot)).filter(
      (name) => name.endsWith(".lock") || name.endsWith(".tmp"),
    );
    assert.deepEqual(leftovers, []);
  } finally {
    await connection?.close().catch(() => {});
    await rm(registryRoot, { recursive: true, force: true });
  }
});

test("connectNamed rejects an alive holder whose endpoint hangs", async () => {
  const registryRoot = await mkdtemp(
    path.join(tmpdir(), "omowright-instances-"),
  );
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  try {
    await writeRecord(
      registryRoot,
      "hung",
      instanceRecord("hung", { pid: process.pid, endpoint }),
    );

    await assert.rejects(
      connectNamed("hung", { registryRoot, probeTimeoutMs: 250 }),
      (error) => {
        assert.match(error.message, /unresponsive holder/);
        assert.match(error.message, new RegExp(`pid ${process.pid}`));
        assert.match(
          error.message,
          new RegExp(endpoint.replaceAll(".", "\\.")),
        );
        return true;
      },
    );
  } finally {
    server.close();
    await rm(registryRoot, { recursive: true, force: true });
  }
});

test("connectNamed recovers from a malformed record", async () => {
  const registryRoot = await mkdtemp(
    path.join(tmpdir(), "omowright-instances-"),
  );
  const recordPath = path.join(registryRoot, "malformed.json");
  await writeFile(recordPath, "{not-json}\n", { mode: 0o600 });
  let connection;
  try {
    connection = await connectNamed("malformed", {
      registryRoot,
      browserPath: process.execPath,
      browserArgs: [fixture],
    });

    const rewritten = JSON.parse(await readFile(recordPath, "utf8"));
    assert.equal(rewritten.version, 2);
    assert.equal(rewritten.name, "malformed");
    assert.equal(rewritten.pid, connection.browserProcess.pid);
  } finally {
    await connection?.close().catch(() => {});
    await rm(registryRoot, { recursive: true, force: true });
  }
});

// Covers the in-process queue only: both calls share one `acquireLocalLock`
// chain, so the file lock is barely reached. The cross-process test below owns
// that contract.
test("concurrent connectNamed calls launch exactly one browser", async () => {
  const registryRoot = await mkdtemp(
    path.join(tmpdir(), "omowright-instances-"),
  );
  const options = {
    registryRoot,
    browserPath: process.execPath,
    browserArgs: [fixture],
  };
  let connections = [];
  try {
    connections = await Promise.all([
      connectNamed("shared", options),
      connectNamed("shared", options),
    ]);

    const launched = connections.filter(
      (connection) => connection.browserProcess,
    );
    assert.equal(launched.length, 1);
    const record = JSON.parse(
      await readFile(path.join(registryRoot, "shared.json"), "utf8"),
    );
    assert.equal(record.pid, launched[0].browserProcess.pid);
    assert.deepEqual(
      await connections[0].listTargets(),
      await connections[1].listTargets(),
    );

    const attached = connections.find(
      (connection) => !connection.browserProcess,
    );
    await attached.close();
    connections = connections.filter((connection) => connection !== attached);
    assert.doesNotThrow(() => process.kill(record.pid, 0));
  } finally {
    await Promise.all(
      connections.map((connection) => connection.close().catch(() => {})),
    );
    await rm(registryRoot, { recursive: true, force: true });
  }
});

// Contract owner: the cross-process registry lock. Two separate processes race
// on one name through a stdin barrier, so nothing in a single process's memory
// can serialize them: a lock that two holders can enter launches two browsers
// here and leaves one of them unregistered.
test("two processes racing one name launch exactly one browser", { timeout: 30_000 }, async () => {
  const registryRoot = await mkdtemp(
    path.join(tmpdir(), "omowright-instances-"),
  );
  const children = [];
  const results = [];
  try {
    const runs = [0, 1].map(
      (index) =>
        new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [lockRaceChild, registryRoot, "contended"],
            { stdio: ["pipe", "pipe", "pipe"] },
          );
          children.push(child);
          let stdout = "";
          let stderr = "";
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (chunk) => {
            stdout += chunk;
            if (!child.ready && stdout.includes("READY\n")) {
              child.ready = true;
              child.emit("barrier-ready");
            }
          });
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          child.once("error", reject);
          child.once("close", (code) => {
            if (code !== 0) {
              reject(new Error(`child ${index} exited ${code}:\n${stderr}`));
              return;
            }
            const payload = stdout.trim().split("\n").at(-1);
            try {
              resolve(JSON.parse(payload));
            } catch (error) {
              reject(
                new Error(`child ${index} printed ${payload}: ${error.message}`),
              );
            }
          });
        }),
    );

    await Promise.all(
      children.map((child) =>
        child.ready ? undefined : once(child, "barrier-ready"),
      ),
    );
    for (const child of children) child.stdin.write("go\n");
    results.push(...(await Promise.all(runs)));

    const launched = results.filter((result) => result.launched);
    assert.equal(launched.length, 1);
    const record = JSON.parse(
      await readFile(path.join(registryRoot, "contended.json"), "utf8"),
    );
    assert.equal(record.pid, launched[0].browserPid);
    // The loser attached instead of launching: it drove a live browser and the
    // one browser in the registry outlived both processes.
    for (const result of results) assert.deepEqual(result.targets, [fakeTarget]);
    assert.doesNotThrow(() => process.kill(record.pid, 0));
    const leftovers = (await readdir(registryRoot)).filter(
      (name) => !name.endsWith(".json"),
    );
    assert.deepEqual(leftovers, []);
  } finally {
    for (const result of results) {
      if (!result.browserPid) continue;
      try {
        process.kill(result.browserPid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    for (const child of children) await stopChild(child);
    await rm(registryRoot, { recursive: true, force: true });
  }
});

// Contract owner: what counts as an abandoned lock. A lock with no readable
// identity is a contender caught between creating and writing its file, so
// reclaiming it on sight lets two callers hold the same name.
test("connectNamed treats an identity-less lock as held until it ages out", async () => {
  const registryRoot = await mkdtemp(
    path.join(tmpdir(), "omowright-instances-"),
  );
  const lockPath = path.join(registryRoot, "halfwritten.lock");
  const options = {
    registryRoot,
    browserPath: process.execPath,
    browserArgs: [fixture],
  };
  let connection;
  try {
    await writeFile(lockPath, "", { mode: 0o600 });

    await assert.rejects(
      connectNamed("halfwritten", { ...options, lockTimeoutMs: 300 }),
      /timed out waiting for instance lock/,
    );
    // The lock survived: nothing stole it and nothing was launched.
    assert.equal((await stat(lockPath)).size, 0);
    assert.deepEqual(await readdir(registryRoot), ["halfwritten.lock"]);

    // Older than any legitimate hold, it is finally reclaimed.
    const aged = new Date(Date.now() - 3_600_000);
    await utimes(lockPath, aged, aged);
    connection = await connectNamed("halfwritten", options);

    assert.equal(connection.browserProcess?.pid > 0, true);
    assert.deepEqual(
      (await readdir(registryRoot)).filter((name) => !name.endsWith(".json")),
      [],
    );
  } finally {
    await connection?.close().catch(() => {});
    await rm(registryRoot, { recursive: true, force: true });
  }
});

// Contract owner: what counts as an abandoned lock. A live pid alone is not the
// holder: once the holder dies its pid can be handed to an unrelated process,
// and a pid-only check would keep the name locked until that process exits.
test("connectNamed reclaims a lock whose pid now belongs to another process", async () => {
  const registryRoot = await mkdtemp(
    path.join(tmpdir(), "omowright-instances-"),
  );
  const lockPath = path.join(registryRoot, "reused.lock");
  const unrelated = await launchFakeBrowser();
  let connection;
  try {
    await writeFile(
      lockPath,
      `${JSON.stringify({
        pid: unrelated.child.pid,
        start: "a start time this pid never had",
        token: "crashed-holder",
        acquiredAt: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );

    connection = await connectNamed("reused", {
      registryRoot,
      browserPath: process.execPath,
      browserArgs: [fixture],
      lockTimeoutMs: 3_000,
    });

    assert.equal(connection.browserProcess?.pid > 0, true);
    assert.notEqual(connection.browserProcess.pid, unrelated.child.pid);
    assert.doesNotThrow(() => process.kill(unrelated.child.pid, 0));
  } finally {
    await connection?.close().catch(() => {});
    await stopChild(unrelated.child);
    await rm(registryRoot, { recursive: true, force: true });
  }
});

// Contract owner: the takeover never deletes a live lock. Filesystems such as
// ext4 reuse inode numbers, so a reclaimer that inspected a dead lock can later
// find a new holder's lock under the same inode; the token written into every
// lock is what tells them apart. Test seam: reclaimLock is called directly
// because no timing can force an inode to be reused.
test("reclaimLock leaves a live lock that reuses the dead lock's inode", async () => {
  const registryRoot = await mkdtemp(
    path.join(tmpdir(), "omowright-instances-"),
  );
  const lockPath = path.join(registryRoot, "reused-inode.lock");
  const live = `${JSON.stringify({
    pid: process.pid,
    token: "live-holder",
    acquiredAt: new Date().toISOString(),
  })}\n`;
  try {
    await writeFile(lockPath, live, { mode: 0o600 });
    const { ino } = await stat(lockPath);

    assert.equal(await reclaimLock(lockPath, ino, "dead-holder"), false);

    assert.equal(await readFile(lockPath, "utf8"), live);
    assert.deepEqual(await readdir(registryRoot), ["reused-inode.lock"]);
  } finally {
    await rm(registryRoot, { recursive: true, force: true });
  }
});

// Contract owner: the takeover never deletes a live lock, even when a third
// contender takes the name while the lock is moved aside. Test seam: the hooks
// run at the two points between reclaimLock's checks and its filesystem steps,
// because no timing can force another process into those gaps.
function lockText(pid, token) {
  return `${JSON.stringify({ pid, token, acquiredAt: new Date().toISOString() })}\n`;
}

async function writeLiveLock(lockPath, token) {
  await rm(lockPath, { force: true });
  await writeFile(lockPath, lockText(process.pid, token), { mode: 0o600 });
}

test("reclaimLock puts a live lock back after a third contender took the name", async () => {
  const registryRoot = await mkdtemp(
    path.join(tmpdir(), "omowright-instances-"),
  );
  const lockPath = path.join(registryRoot, "three-way.lock");
  try {
    await writeFile(lockPath, lockText(deadPid(), "dead-holder"), { mode: 0o600 });
    const { ino } = await stat(lockPath);
    let blocked = 0;

    const reclaimed = await reclaimLock(lockPath, ino, "dead-holder", {
      hooks: {
        // The dead lock is replaced by a live one after the checks passed ...
        beforeMove: () => writeLiveLock(lockPath, "live-holder"),
        // ... and once that live lock is moved aside, a third contender locks the name.
        afterMove: () =>
          writeFile(lockPath, lockText(process.pid, "third"), { mode: 0o600 }),
        onPutBackBlocked: async () => {
          blocked += 1;
          if (blocked === 1) await rm(lockPath);
        },
      },
    });

    assert.equal(reclaimed, false);
    assert.equal(blocked, 1, "the put-back met the third contender's lock once");
    assert.equal(JSON.parse(await readFile(lockPath, "utf8")).token, "live-holder");
    assert.deepEqual(await readdir(registryRoot), ["three-way.lock"]);
  } finally {
    await rm(registryRoot, { recursive: true, force: true });
  }
});

test("a holder that releases while its lock is moved aside leaves no lock behind", async () => {
  const registryRoot = await mkdtemp(
    path.join(tmpdir(), "omowright-instances-"),
  );
  const lockPath = path.join(registryRoot, "release-aside.lock");
  const lockOptions = { timeoutMs: 5_000, staleGraceMs: 60_000 };
  let finishHold;
  let holding;
  let held = false;
  try {
    await writeFile(lockPath, lockText(deadPid(), "dead-holder"), { mode: 0o600 });
    const { ino } = await stat(lockPath);

    const reclaimed = await reclaimLock(lockPath, ino, "dead-holder", {
      hooks: {
        beforeMove: async () => {
          await rm(lockPath);
          const entered = new Promise((resolve) => {
            holding = withLock(lockPath, lockOptions, () => {
              resolve();
              return new Promise((done) => {
                finishHold = done;
              });
            });
          });
          await entered;
        },
        afterMove: () =>
          writeFile(lockPath, lockText(process.pid, "third"), { mode: 0o600 }),
        onPutBackBlocked: async () => {
          if (held) return;
          held = true;
          finishHold();
          await holding;
          await rm(lockPath);
        },
      },
    });

    assert.equal(reclaimed, false);
    await assert.rejects(stat(lockPath), (error) => error?.code === "ENOENT");
    assert.deepEqual(await readdir(registryRoot), []);
  } finally {
    finishHold?.();
    await rm(registryRoot, { recursive: true, force: true });
  }
});

// Contract owner: holder identity. A live pid and an answering loopback port
// are both reusable by anything else on the machine; only the recorded
// WebSocket URL (it carries the browser GUID) proves the holder is ours.
test("connectNamed relaunches when a stranger answers on the recorded endpoint", async () => {
  const registryRoot = await mkdtemp(
    path.join(tmpdir(), "omowright-instances-"),
  );
  const stranger = await launchFakeBrowser();
  let connection;
  try {
    await writeRecord(
      registryRoot,
      "foreign",
      instanceRecord("foreign", {
        pid: stranger.child.pid,
        endpoint: stranger.endpoint,
        webSocketDebuggerUrl: `${stranger.webSocketDebuggerUrl}-of-a-browser-that-exited`,
      }),
    );

    connection = await connectNamed("foreign", {
      registryRoot,
      browserPath: process.execPath,
      browserArgs: [fixture],
    });

    assert.equal(connection.browserProcess?.pid > 0, true);
    assert.notEqual(connection.browserProcess.pid, stranger.child.pid);
    const rewritten = JSON.parse(
      await readFile(path.join(registryRoot, "foreign.json"), "utf8"),
    );
    assert.equal(rewritten.pid, connection.browserProcess.pid);
    assert.notEqual(rewritten.endpoint, stranger.endpoint);
  } finally {
    await connection?.close().catch(() => {});
    await stopChild(stranger.child);
    await rm(registryRoot, { recursive: true, force: true });
  }
});

// Another browser's CDP endpoint: answers discovery as itself and counts every
// WebSocket upgrade, so a launch that dials it is caught.
async function decoyEndpoint() {
  const upgrades = [];
  const server = createServer((request, response) => {
    if (request.url !== "/json/version") return void response.writeHead(404).end();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      Browser: "Decoy/1.0",
      webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/decoy`,
    }));
  });
  const webSockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      upgrades.push(request.url);
      webSocket.on("message", (data) => {
        const { id } = JSON.parse(data.toString());
        webSocket.send(JSON.stringify({ id, result: {} }));
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: server.address().port,
    upgrades,
    async close() {
      for (const webSocket of webSockets.clients) webSocket.terminate();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// Contract owner: launch endpoint identity (#74). A DevToolsActivePort that was
// in the profile before the launch belongs to an earlier run or to another
// browser on that profile (a user's Chrome writes one when remote debugging is
// enabled), so the launch must never dial the port it names.
test("connectNamed ignores a DevToolsActivePort left before the launch", async () => {
  const registryRoot = await mkdtemp(path.join(tmpdir(), "omowright-instances-"));
  const profileDir = path.join(registryRoot, "profile");
  await mkdir(profileDir);
  const decoy = await decoyEndpoint();
  const stalePort = path.join(profileDir, "DevToolsActivePort");
  await writeFile(stalePort, `${decoy.port}\n/devtools/browser/decoy`);
  const past = new Date(Date.now() - 60_000);
  await utimes(stalePort, past, past);
  let connection;
  try {
    connection = await connectNamed("stale-port", {
      registryRoot,
      browserPath: process.execPath,
      browserArgs: [fixture, `--user-data-dir=${profileDir}`],
      profileDir,
    });

    assert.deepEqual(await connection.listTargets(), [fakeTarget]);
    const record = JSON.parse(await readFile(path.join(registryRoot, "stale-port.json"), "utf8"));
    assert.equal(record.pid, connection.browserProcess.pid);
    assert.notEqual(record.endpoint, `http://127.0.0.1:${decoy.port}`);
    assert.deepEqual(decoy.upgrades, []);
  } finally {
    await connection?.close().catch(() => {});
    await decoy.close();
    await rm(registryRoot, { recursive: true, force: true });
  }
});

test("connectNamed refuses a launch endpoint that answers as another browser", async () => {
  const registryRoot = await mkdtemp(path.join(tmpdir(), "omowright-instances-"));
  const profileDir = path.join(registryRoot, "profile");
  await mkdir(profileDir);
  const decoy = await decoyEndpoint();
  let connection;
  try {
    const error = await connectNamed("foreign-port", {
      registryRoot,
      browserPath: process.execPath,
      browserArgs: [
        fixture,
        `--user-data-dir=${profileDir}`,
        "--fake-quiet",
        `--fake-active-port=${decoy.port}`,
      ],
      profileDir,
    }).then((attached) => {
      connection = attached;
      return null;
    }, (rejection) => rejection);
    assert.deepEqual(decoy.upgrades, []);
    assert.match(
      String(error?.message),
      /answers as \/devtools\/browser\/decoy, not as the launched browser \(\/devtools\/browser\/fake\)/,
    );
    await assert.rejects(
      stat(path.join(registryRoot, "foreign-port.json")),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    await connection?.close().catch(() => {});
    await decoy.close();
    await rm(registryRoot, { recursive: true, force: true });
  }
});

// Contract owner: the attach handshake bound. Discovery answering says nothing
// about the WebSocket upgrade behind it, and an unbounded attach hangs the
// caller forever instead of naming the holder.
test("connectNamed gives up when the holder's WebSocket upgrade hangs", async () => {
  const registryRoot = await mkdtemp(
    path.join(tmpdir(), "omowright-instances-"),
  );
  const held = new Set();
  const server = createServer((request, response) => {
    if (request.url !== "/json/version") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        Browser: "StalledBrowser/1.0",
        webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/stalled`,
      }),
    );
  });
  // Accept the upgrade and answer never.
  server.on("upgrade", (_request, socket) => held.add(socket));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  try {
    await writeRecord(
      registryRoot,
      "stalled",
      instanceRecord("stalled", {
        pid: process.pid,
        endpoint,
        webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/stalled`,
      }),
    );

    await assert.rejects(
      connectNamed("stalled", {
        registryRoot,
        probeTimeoutMs: 1_000,
        connectTimeoutMs: 300,
      }),
      (error) => {
        assert.match(error.message, /unresponsive holder "stalled"/);
        assert.match(error.message, /timed out after 300ms/);
        assert.match(error.message, new RegExp(endpoint.replaceAll(".", "\\.")));
        return true;
      },
    );
  } finally {
    for (const socket of held) socket.destroy();
    server.close();
    await rm(registryRoot, { recursive: true, force: true });
  }
});

test("listInstances reports versioned records with liveness metadata", async () => {
  const registryRoot = await mkdtemp(
    path.join(tmpdir(), "omowright-instances-"),
  );
  const fake = await launchFakeBrowser();
  try {
    await writeRecord(
      registryRoot,
      "alive",
      instanceRecord("alive", {
        pid: fake.child.pid,
        endpoint: fake.endpoint,
      }),
    );
    await writeRecord(
      registryRoot,
      "dead",
      instanceRecord("dead", {
        pid: deadPid(),
        endpoint: "http://127.0.0.1:1",
      }),
    );
    await writeFile(path.join(registryRoot, "broken.json"), "not json\n", {
      mode: 0o600,
    });
    await chmod(path.join(registryRoot, "alive.json"), 0o644);

    const instances = await listInstances({ registryRoot });

    assert.deepEqual(
      instances.map((instance) => instance.name),
      ["alive", "dead"],
    );
    assert.deepEqual(
      Object.keys(instances[0]).sort(),
      [
        "alive",
        "browserPath",
        "endpoint",
        "name",
        "pid",
        "profileDir",
        "responsive",
        "startedAt",
        "version",
        "webSocketDebuggerUrl",
      ].sort(),
    );
    assert.equal(instances[0].alive, true);
    assert.equal(instances[0].responsive, true);
    assert.equal(instances[1].alive, false);
    assert.equal(instances[1].responsive, false);
    assert.equal(
      (await stat(path.join(registryRoot, "alive.json"))).mode & 0o777,
      0o600,
    );
  } finally {
    await stopChild(fake.child);
    await rm(registryRoot, { recursive: true, force: true });
  }
});
