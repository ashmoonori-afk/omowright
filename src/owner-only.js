// Owner-only access for the registry, lock and CloakBrowser profile state.
// POSIX expresses it with mode bits. On Windows chmod only toggles the
// read-only attribute, so the same property is a protected DACL that grants the
// current user alone: inherited entries (the parent's grants to other users or
// groups) are dropped, and files created inside a directory inherit its grant.
// Explicit entries already on the object are kept, as macOS keeps a file's
// extended ACL through a chmod.
import { execFile } from "node:child_process";
import { chmod } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WINDOWS_COMMAND_TIMEOUT_MS = 15_000;
let currentUserSid;

async function readCurrentUserSid() {
  const { stdout } = await execFileAsync("whoami", ["/user", "/fo", "csv", "/nh"], {
    timeout: WINDOWS_COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  const sid = /"(S-1-[\d-]+)"\s*$/.exec(String(stdout).trim())?.[1];
  if (!sid) throw new Error(`cannot read the current user's SID from whoami: ${String(stdout).trim()}`);
  return sid;
}

function cachedCurrentUserSid() {
  currentUserSid ??= readCurrentUserSid().catch((error) => {
    currentUserSid = undefined;
    throw error;
  });
  return currentUserSid;
}

export async function restrictToOwner(target, kind) {
  if (process.platform !== "win32") {
    await chmod(target, kind === "directory" ? 0o700 : 0o600);
    return;
  }
  const sid = await cachedCurrentUserSid();
  const grant = kind === "directory" ? `*${sid}:(OI)(CI)F` : `*${sid}:F`;
  await execFileAsync("icacls", [target, "/inheritance:r", "/grant:r", grant, "/Q"], {
    timeout: WINDOWS_COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
}
