import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
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
