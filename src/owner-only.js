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
// inherited ACL in place. A volume without ACLs (FAT32, exFAT, some network
// shares) cannot hold the grant, so icacls fails there and so does the caller.
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WINDOWS_COMMAND_TIMEOUT_MS = 15_000;
// Directories this process restricted or found restricted, by lower-cased path.
const ownerOnlyDirectories = new Set();
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

// The directory's DACL as SDDL. `icacls /save` without /T reads this one
// object only and writes it, as UTF-16, to a file.
async function readDirectoryDacl(dir, run) {
  const scratch = await mkdtemp(path.join(tmpdir(), "omowright-acl-"));
  try {
    const saved = path.join(scratch, "acl");
    await run(windowsSystemTool("icacls.exe"), [dir, "/save", saved, "/Q"], {
      timeout: WINDOWS_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    const bytes = await readFile(saved);
    const text = bytes.length > 1 && bytes[1] === 0 ? bytes.toString("utf16le") : bytes.toString("utf8");
    return /D:[^\r\n]*/.exec(text)?.[0] ?? "";
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// True when the DACL is already what the directory grant below leaves:
// protected, with the user's one entry being the inheritable full-control
// allow. SDDL names the built-in Administrator and Guest accounts LA and LG.
function isOwnerOnlyDirectoryDacl(dacl, sid) {
  const match = /^D:([A-Z]*)((?:\([^()]*\))*)/.exec(dacl);
  if (!match || !match[1].includes("P")) return false;
  const isUser = (trustee) =>
    trustee === sid || (trustee === "LA" && sid.endsWith("-500")) || (trustee === "LG" && sid.endsWith("-501"));
  const own = [...match[2].matchAll(/\(([^()]*)\)/g)].map(([, ace]) => ace.split(";")).filter((fields) => isUser(fields[5]));
  return own.length === 1 && own[0][0] === "A" && own[0][1] === "OICI" && own[0][2] === "FA";
}

// `platform` and `run` let the security contract above (absolute tool paths,
// fail closed) be tested off Windows; production callers pass neither.
export async function restrictToOwner(target, kind, { platform = process.platform, run } = {}) {
  if (platform !== "win32") {
    await chmod(target, kind === "directory" ? 0o700 : 0o600);
    return;
  }
  const command = run ?? execFileAsync;
  const sid = run ? await readCurrentUserSid(run) : await cachedCurrentUserSid();
  // Re-granting an inheritable entry makes Windows rewrite the inherited
  // entries of everything below the directory, thousands of files in a used
  // browser profile, so a directory that already holds the grant is left as is.
  if (kind === "directory" && isOwnerOnlyDirectoryDacl(await readDirectoryDacl(target, command), sid)) {
    ownerOnlyDirectories.add(path.win32.resolve(target).toLowerCase());
    return;
  }
  const grant = kind === "directory" ? `*${sid}:(OI)(CI)F` : `*${sid}:F`;
  await command(windowsSystemTool("icacls.exe"), [target, "/inheritance:r", "/grant:r", grant, "/Q"], {
    timeout: WINDOWS_COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  if (kind === "directory") ownerOnlyDirectories.add(path.win32.resolve(target).toLowerCase());
}

// For a file the caller has just created. On Windows a file created inside a
// directory restrictToOwner handled in this process inherits that directory's
// owner-only grant at creation, so no tool runs for it.
export async function restrictNewFileToOwner(target, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32" && ownerOnlyDirectories.has(path.win32.dirname(path.win32.resolve(target)).toLowerCase())) return;
  await restrictToOwner(target, "file", options);
}
