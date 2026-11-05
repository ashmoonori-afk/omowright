import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { link, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createLock,
  isSameLock,
  processStartTime,
  readLockState,
} from "./lock-file.js";

const LOCK_POLL_INTERVAL_MS = 250;
const LOCK_RETRY_JITTER_MS = 25;
const LOCK_PUT_BACK_TIMEOUT_MS = 30_000;
const localLocks = new Map();

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") return true;
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

export async function unlinkIfPresent(target) {
  await unlink(target).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function isAbandoned(state, staleGraceMs, startTimeOf) {
  if (state.pid === null) return Date.now() - state.mtimeMs >= staleGraceMs;
  if (!isPidAlive(state.pid)) return true;
  if (state.start === null) return false;
  const start = await startTimeOf(state.pid, state.start);
  return start !== null && start !== state.start;
}

// Deletes only the lock that was proved abandoned, identified by inode AND
// token, never another one. The rename is the exclusive step: of two
// reclaimers only one moves a given entry, and whatever we moved is ours alone
// to inspect. An inode number alone is not enough because ext4 reuses them, so
// a live lock created after the dead one vanished can carry the same inode;
// its token differs, and anything that does not match is put back.
// Known residuals of a takeover built from path operations (#62 replaces it):
// while a live lock is moved aside another contender can take the name, so two
// processes hold it until the put-back; and a holder that releases while its
// lock is moved aside can have that finished lock put back, which keeps the
// name locked until the holder's process exits.
// `hooks` lets a test run code inside the gaps between these steps.
export async function reclaimLock(lockPath, ino, token, { deadline = Date.now() + LOCK_PUT_BACK_TIMEOUT_MS, hooks = {} } = {}) {
  if (!isSameLock(await readLockState(lockPath), ino, token)) {
    return (await stat(lockPath).catch(() => null)) === null;
  }
  const movedPath = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
  await hooks.beforeMove?.();
  try {
    await rename(lockPath, movedPath);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  await hooks.afterMove?.();
  if (isSameLock(await readLockState(movedPath).catch(() => null), ino, token)) {
    await unlinkIfPresent(movedPath);
    return true;
  }
  await putBack(movedPath, lockPath, deadline, hooks);
  return false;
}

// The moved file is a live holder's lock. While the name was empty another
// contender may have locked it; the moved lock then waits for that one to go.
// It is never deleted here: it leaves only when it is back under its name, when
// its holder released it (releaseLock removes moved copies of its own lock), or
// it stays where it is past the deadline for that holder to release.
async function putBack(movedPath, lockPath, deadline, hooks) {
  for (;;) {
    try {
      await link(movedPath, lockPath);
      await unlinkIfPresent(movedPath);
      return;
    } catch (error) {
      if (error?.code === "ENOENT") return;
      if (error?.code !== "EEXIST") throw error;
    }
    await hooks.onPutBackBlocked?.();
    if ((await stat(movedPath).catch(() => null)) === null) return;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return;
    await waitForLockRelease(lockPath, Math.min(remainingMs, LOCK_POLL_INTERVAL_MS));
  }
}

// Unlink only entries that still name the lock we created: if ours was
// reclaimed under us, the file at this path belongs to the next owner. A
// reclaimer may be holding our lock moved aside, so those copies go first;
// checked in this order, a copy put back meanwhile is found under the name.
async function releaseLock(lockPath, ino, token) {
  const prefix = `${path.basename(lockPath)}.`;
  const entries = await readdir(path.dirname(lockPath)).catch(() => []);
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".stale")) continue;
    const moved = path.join(path.dirname(lockPath), entry);
    if (isSameLock(await readLockState(moved).catch(() => null), ino, token)) {
      await unlinkIfPresent(moved);
    }
  }
  if (!isSameLock(await readLockState(lockPath), ino, token)) return;
  await unlinkIfPresent(lockPath);
}

function waitForLockRelease(lockPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let watcher;
    let timer;
    const finish = (error, released) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher?.close();
      if (error) reject(error);
      else resolve(released);
    };
    const check = () => {
      stat(lockPath).then(
        () => {},
        (error) => {
          if (error?.code === "ENOENT") finish(null, true);
          else finish(error);
        },
      );
    };
    try {
      watcher = watch(path.dirname(lockPath), (event, filename) => {
        if (
          (event === "rename" || event === "change") &&
          (!filename || filename.toString() === path.basename(lockPath))
        ) {
          check();
        }
      });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        finish(error);
        return;
      }
    }
    timer = setTimeout(() => finish(null, false), timeoutMs);
    check();
  });
}

async function acquireLock(lockPath, timeoutMs, staleGraceMs, lookupStartTime) {
  const deadline = Date.now() + timeoutMs;
  // A live holder's start time cannot change while we wait, and on Windows each
  // lookup is a PowerShell call of about a second, so one acquire looks each
  // holder up once. A holder is its pid AND the start time its lock records:
  // keyed by pid alone, a lookup made for one holder would be compared with
  // the lock of a later process that reused its pid, and that live lock would
  // be reclaimed. A holder that dies is still caught by isPidAlive; only a pid
  // reused within one wait pass escapes it, and the wait then times out.
  const startTimes = new Map();
  const startTimeOf = async (pid, recordedStart) => {
    const key = `${pid}:${recordedStart}`;
    if (!startTimes.has(key)) {
      const start = await lookupStartTime(pid);
      if (start === null) return null;
      startTimes.set(key, start);
    }
    return startTimes.get(key);
  };
  let holderPid = null;
  for (;;) {
    const ours = await createLock(lockPath);
    if (ours !== null) return () => releaseLock(lockPath, ours.ino, ours.token);
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for instance lock held by pid ${holderPid ?? "unknown"}`,
      );
    }

    const state = await readLockState(lockPath);
    if (state === null) continue;
    holderPid = state.pid ?? holderPid;
    if (await isAbandoned(state, staleGraceMs, startTimeOf)) {
      await reclaimLock(lockPath, state.ino, state.token, { deadline });
      // Jitter keeps two reclaimers from retrying in lockstep forever.
      await sleep(Math.random() * LOCK_RETRY_JITTER_MS);
      continue;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await waitForLockRelease(lockPath, Math.min(remainingMs, LOCK_POLL_INTERVAL_MS));
    }
  }
}

async function acquireLocalLock(key) {
  const previous = localLocks.get(key) ?? Promise.resolve();
  let releaseCurrent;
  const current = new Promise((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.then(() => current);
  localLocks.set(key, tail);
  await previous;
  return () => {
    releaseCurrent();
    if (localLocks.get(key) === tail) localLocks.delete(key);
  };
}

// Runs `run` while this process and every other one agree we hold `lockPath`.
// A lock with no readable identity counts as held until it is `staleGraceMs` old.
// `startTimeOf` lets a test count start-time lookups and stand in for a reused
// pid; production callers pass none.
export async function withLock(lockPath, { timeoutMs, staleGraceMs, startTimeOf = processStartTime }, run) {
  const releaseLocal = await acquireLocalLock(lockPath);
  try {
    const release = await acquireLock(lockPath, timeoutMs, staleGraceMs, startTimeOf);
    try {
      return await run();
    } finally {
      await release();
    }
  } finally {
    releaseLocal();
  }
}
