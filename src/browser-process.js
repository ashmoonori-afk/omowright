// Lifecycle of a browser the pipe transport spawns. Chrome removes its per-launch
// state (the macOS code-sign clone of the app bundle, a temp profile) only when
// it quits cleanly, so nothing here sends SIGKILL before a SIGTERM and a bounded
// grace window (omo#12067).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isPidAlive } from "./instance-lock.js";
import { ownProcessStartTime, processStartTime } from "./lock-file.js";

export const TERM_GRACE_MS = 5_000;
const PID_FILE_NAME = "omowright-browser.pid";
const REAP_POLL_MS = 50;

// Own process group on POSIX: a group-wide SIGKILL of the caller (an eval cell
// settling, `timeout -s KILL`) no longer takes the browser with it; the browser
// instead reads EOF on its CDP pipe and quits on its own. Windows has no process
// groups to escape, and `detached` there would open a console window.
export const browserSpawnDetached = process.platform !== "win32";

export function profileDirFromArgs(browserArgs) {
  for (let index = 0; index < browserArgs.length; index += 1) {
    const argument = browserArgs[index];
    if (argument === "--user-data-dir" && browserArgs[index + 1]) return path.resolve(browserArgs[index + 1]);
    if (argument.startsWith("--user-data-dir=")) return path.resolve(argument.slice("--user-data-dir=".length));
  }
  return null;
}

export async function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try { child.kill("SIGTERM"); } catch {}
  let timer;
  const graceOver = new Promise((resolve) => { timer = setTimeout(resolve, TERM_GRACE_MS); });
  await Promise.race([exited, graceOver]);
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill("SIGKILL"); } catch {}
    await exited;
  }
}

function pidFilePath(profileDir) {
  return path.join(profileDir, PID_FILE_NAME);
}

// Records the browser and the caller that owns it. The profile dir is created
// first: the pidfile is written right after spawn, before Chrome has made its
// --user-data-dir (Chrome itself is happy with a dir that already exists).
export async function writeBrowserPidFile(profileDir, pid) {
  if (!profileDir || !pid) return;
  const [start, ownerStart] = await Promise.all([processStartTime(pid), ownProcessStartTime()]);
  mkdirSync(profileDir, { recursive: true });
  const record = { pid, start, profileDir, owner: { pid: process.pid, start: ownerStart } };
  writeFileSync(pidFilePath(profileDir), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export function removeBrowserPidFile(profileDir, pid) {
  if (!profileDir) return;
  try {
    const recorded = JSON.parse(readFileSync(pidFilePath(profileDir), "utf8"));
    if (recorded.pid !== pid) return;
  } catch {
    return;
  }
  rmSync(pidFilePath(profileDir), { force: true });
}

// Same process as when recorded: alive, and (when a start time was recorded and
// can be read now) the same start time, so a recycled pid does not count.
// Returns null when the answer cannot be determined.
async function sameProcessAlive(pid, start) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!isPidAlive(pid)) return false;
  if (start === null || start === undefined) return null;
  const now = await processStartTime(pid);
  if (now === null) return null;
  return now === start;
}

// A pidfile left in the profile names a browser whose caller died without
// close(). Give it the same SIGTERM-then-grace treatment before reusing the
// profile. Every doubt fails toward keeping the browser: it is reaped only when
// it is provably the recorded process AND its recorded caller is provably gone,
// so a live client's browser on the same profile is never touched.
export async function reapOrphanedBrowser(profileDir) {
  if (!profileDir) return;
  let recorded;
  try {
    recorded = JSON.parse(readFileSync(pidFilePath(profileDir), "utf8"));
  } catch {
    return;
  }
  const { pid, start, owner } = recorded;
  const browserAlive = Number.isInteger(pid) && pid > 0 ? await sameProcessAlive(pid, start) : false;
  if (browserAlive === false) {
    rmSync(pidFilePath(profileDir), { force: true });
    return;
  }
  if (browserAlive === null || pid === process.pid) return;
  const ownerAlive = await sameProcessAlive(owner?.pid, owner?.start);
  if (ownerAlive !== false) return;
  try { process.kill(pid, "SIGTERM"); } catch {}
  const deadline = Date.now() + TERM_GRACE_MS;
  while (isPidAlive(pid) && Date.now() < deadline) await sleep(REAP_POLL_MS);
  if (isPidAlive(pid)) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  rmSync(pidFilePath(profileDir), { force: true });
}
