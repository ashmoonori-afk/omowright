import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, link, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WINDOWS_START_TIME_TIMEOUT_MS = 15_000;
let ownStartTime;

// When the process holding `pid` started, in a form that only has to compare
// equal to itself on this machine; null when the platform cannot say. A dead
// holder's pid can be reused, and pid plus start time is what stays unique.
export async function processStartTime(pid) {
  if (process.platform === "win32") {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    // Win32_Process.CreationDate is readable for every process, not only the
    // caller's own (Get-Process StartTime is not), and a reused pid usually
    // belongs to someone else. FILETIME ticks keep the value locale-free.
    // PowerShell is spawned by absolute path: a bare name resolves from the cwd
    // before PATH, which another user may be able to write.
    const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
    try {
      const { stdout } = await execFileAsync(
        path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${pid}').CreationDate.ToFileTimeUtc()`,
        ],
        { timeout: WINDOWS_START_TIME_TIMEOUT_MS, windowsHide: true },
      );
      const ticks = String(stdout).trim();
      return /^\d+$/.test(ticks) ? ticks : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "linux") {
    try {
      const text = await readFile(`/proc/${pid}/stat`, "utf8");
      // Field 22 (starttime); the fields after the parenthesised comm start at 3.
      return text.slice(text.lastIndexOf(")") + 2).split(" ")[19] ?? null;
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// This process's own start time, looked up once: on Windows each lookup is a
// PowerShell call.
export function ownProcessStartTime() {
  ownStartTime ??= processStartTime(process.pid);
  return ownStartTime;
}

// Build the lock out of sight and hard-link it into place, so a lock file is
// never visible half-written: a reader either misses it or reads it whole.
// Returns the inode and token that identify our lock, or null when the path is taken.
export async function createLock(lockPath) {
  const ownStart = ownProcessStartTime();
  const token = randomUUID();
  const tempPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, start: await ownStart, token, acquiredAt: new Date().toISOString() })}\n`,
      "utf8",
    );
    const { ino } = await handle.stat();
    await handle.close();
    handle = null;
    await chmod(tempPath, 0o600);
    try {
      await link(tempPath, lockPath);
    } catch (error) {
      if (error?.code === "EEXIST") return null;
      throw error;
    }
    return { ino, token };
  } finally {
    await handle?.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
  }
}

// Content and inode come from one open handle, so the identity we act on is
// bound to the exact file we inspected rather than to the path.
export async function readLockState(lockPath) {
  let handle;
  try {
    handle = await open(lockPath, "r");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const stats = await handle.stat();
    const text = await handle.readFile("utf8");
    const state = { ino: stats.ino, mtimeMs: stats.mtimeMs, pid: null, start: null, token: null };
    try {
      const value = JSON.parse(text);
      if (Number.isInteger(value?.pid) && value.pid > 0) state.pid = value.pid;
      if (typeof value?.start === "string") state.start = value.start;
      if (typeof value?.token === "string") state.token = value.token;
    } catch {
      // No identity: an empty or partial lock is aged out, never reclaimed on
      // the spot, because a live contender may have just created it.
    }
    return state;
  } finally {
    await handle.close().catch(() => {});
  }
}

export function isSameLock(state, ino, token) {
  return state !== null && state.ino === ino && state.token === token;
}
