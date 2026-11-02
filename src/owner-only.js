// Owner-only access for the registry, lock and CloakBrowser profile state.
// POSIX expresses it with mode bits. On Windows chmod only toggles the
// read-only attribute, so the same property is a protected DACL that grants the
// current user alone: inherited entries (the parent's grants to other users or
// groups) are dropped, and files created inside a directory inherit its grant.
// Explicit entries already on the object are kept, as macOS keeps a file's
// extended ACL through a chmod; on a fresh directory those are Windows' own
// SYSTEM and Administrators entries, the root equivalents.
// The Windows tools are spawned by absolute path: a bare name is resolved from
// the process cwd before PATH, and a cwd another user can write would let them
// substitute the tool. Any failure throws, so a caller never goes on with the
// inherited ACL in place.
import { execFile } from "node:child_process";
import { chmod } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WINDOWS_COMMAND_TIMEOUT_MS = 15_000;
let currentUserSid;

export function windowsSystemTool(name, env = process.env) {
  return path.win32.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", name);
}

async function readCurrentUserSid(run) {
  const { stdout } = await run(windowsSystemTool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
    timeout: WINDOWS_COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  const sid = /"(S-1-[\d-]+)"\s*$/.exec(String(stdout).trim())?.[1];
  if (!sid) throw new Error(`cannot read the current user's SID from whoami: ${String(stdout).trim()}`);
  return sid;
}

function cachedCurrentUserSid() {
  currentUserSid ??= readCurrentUserSid(execFileAsync).catch((error) => {
    currentUserSid = undefined;
    throw error;
  });
  return currentUserSid;
}

// `platform` and `run` let the security contract above (absolute tool paths,
// fail closed) be tested off Windows; production callers pass neither.
export async function restrictToOwner(target, kind, { platform = process.platform, run } = {}) {
  if (platform !== "win32") {
    await chmod(target, kind === "directory" ? 0o700 : 0o600);
    return;
  }
  const sid = run ? await readCurrentUserSid(run) : await cachedCurrentUserSid();
  const grant = kind === "directory" ? `*${sid}:(OI)(CI)F` : `*${sid}:F`;
  await (run ?? execFileAsync)(windowsSystemTool("icacls.exe"), [target, "/inheritance:r", "/grant:r", grant, "/Q"], {
    timeout: WINDOWS_COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
}
