// Owner-only access for the registry, lock and CloakBrowser profile state.
// POSIX expresses it with mode bits. On Windows chmod only toggles the
// read-only attribute, so the same property is a protected DACL that grants the
// current user alone: inherited entries (the parent's grants to other users or
// groups) are dropped, and files created inside a directory inherit its grant.
// A directory keeps its explicit entries for Windows' root equivalents (SYSTEM,
// Administrators, TrustedInstaller) and for OWNER RIGHTS and CREATOR OWNER; an
// explicit grant to anyone else is removed.
// The Windows tools are spawned by absolute path: a bare name is resolved from
// the process cwd before PATH, and a cwd another user can write would let them
// substitute the tool. Any failure throws, so a caller never goes on with the
// inherited ACL in place. A volume without ACLs (FAT32, exFAT, some network
// shares) cannot hold the grant, so icacls fails there and so does the caller.
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WINDOWS_COMMAND_TIMEOUT_MS = 15_000;
// Directories this process restricted or found restricted, by volume and file
// id rather than by name: a directory that later takes a restricted one's name
// never got the grant, and on a case-sensitive NTFS directory two names that
// differ only in case are two directories.
const ownerOnlyDirectories = new Set();
// SDDL trustees that may hold allow entries on an owner-only directory besides
// the user: SYSTEM, Administrators and TrustedInstaller (the trusted set of
// src/native-host-win32.js), OWNER RIGHTS (the owner, the user) and CREATOR
// OWNER (whoever creates a child, on that child). SDDL writes well-known SIDs
// as aliases; their numeric forms are listed too.
const TRUSTED_TRUSTEES = new Set([
  "SY", "S-1-5-18",
  "BA", "S-1-5-32-544",
  "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
  "OW", "S-1-3-4",
  "CO", "S-1-3-0",
]);
const DENY_ACE_TYPES = new Set(["D", "OD", "XD"]);
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

// The flags and ACE fields of an SDDL DACL (`D:` flags, then parenthesized
// ACEs, up to the SACL `S:` that may follow), or null when it does not parse,
// as for `D:NO_ACCESS_CONTROL`. A conditional ACE nests parentheses and may
// quote strings, so ACEs are split at depth zero, skipping quoted text.
function parseDacl(dacl) {
  const head = /^D:([A-Z]*)/.exec(dacl);
  if (!head) return null;
  const aces = [];
  let depth = 0;
  let start = 0;
  let i = head[0].length;
  for (; i < dacl.length; i++) {
    const c = dacl[i];
    if (c === '"' && depth > 0) {
      i = dacl.indexOf('"', i + 1);
      if (i === -1) return null;
    } else if (c === "(") {
      if (depth++ === 0) start = i + 1;
    } else if (c === ")") {
      if (depth === 0) return null;
      if (--depth === 0) aces.push(dacl.slice(start, i).split(";"));
    } else if (depth === 0) {
      break;
    }
  }
  if (depth !== 0 || (i < dacl.length && !dacl.startsWith("S:", i))) return null;
  return { flags: head[1], aces };
}

// Reads a directory DACL against the grant below. `ownerOnly`: already what
// the grant leaves, protected, with the user's one entry being the inheritable
// full-control allow and no allow entry for a trustee outside the trusted set.
// `foreign`: the trustees outside it with explicit allow entries, which the
// grant removes (it drops inherited entries itself). Deny entries grant nothing
// and stay. `parsed` is false for a DACL that could not be read, whose entries
// are unknown. SDDL names the built-in Administrator and Guest accounts LA and LG.
function inspectDirectoryDacl(text, sid) {
  const dacl = parseDacl(text);
  if (!dacl) return { parsed: false, ownerOnly: false, foreign: [] };
  const isUser = (trustee) =>
    trustee === sid || (trustee === "LA" && sid.endsWith("-500")) || (trustee === "LG" && sid.endsWith("-501"));
  const own = dacl.aces.filter((fields) => isUser(fields[5]));
  const others = dacl.aces.filter(([type, , , , , trustee]) => !isUser(trustee) && !TRUSTED_TRUSTEES.has(trustee) && !DENY_ACE_TYPES.has(type));
  return {
    parsed: true,
    ownerOnly: dacl.flags.includes("P") && others.length === 0 &&
      own.length === 1 && own[0][0] === "A" && own[0][1] === "OICI" && own[0][2] === "FA",
    foreign: [...new Set(others.filter(([, flags]) => !flags.includes("ID")).map(([, , , , , trustee]) => trustee))],
  };
}

// The memo key: volume, file id and creation time. The 64-bit id Node reports
// can name a later directory too (ReFS ids are 128-bit, and a file system may
// reuse a deleted directory's id); the creation time tells them apart. A file
// system that reports no file id gives none, and its directories are not
// remembered.
async function directoryIdentity(dir) {
  const { dev, ino, birthtimeNs } = await stat(dir, { bigint: true });
  return ino === 0n ? null : `${dev}:${ino}:${birthtimeNs}`;
}

// The memo only spares later tool runs, so a directory whose identity cannot
// be read is not remembered and files created in it get their own grant.
async function rememberOwnerOnlyDirectory(dir) {
  const identity = await directoryIdentity(dir).catch(() => null);
  if (identity) ownerOnlyDirectories.add(identity);
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
  const dacl = kind === "directory" ? inspectDirectoryDacl(await readDirectoryDacl(target, command), sid) : null;
  if (dacl?.ownerOnly) {
    await rememberOwnerOnlyDirectory(target);
    return;
  }
  const grant = kind === "directory" ? `*${sid}:(OI)(CI)F` : `*${sid}:F`;
  await command(windowsSystemTool("icacls.exe"), [target, "/inheritance:r", "/grant:r", grant, "/Q"], {
    timeout: WINDOWS_COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  if (!dacl) return;
  // The grant keeps explicit entries; another trustee's is removed by SID (an
  // SDDL alias such as WD is a SID string icacls accepts after `*`).
  if (dacl.foreign.length > 0) {
    await command(windowsSystemTool("icacls.exe"), [target, "/remove:g", ...dacl.foreign.map((trustee) => `*${trustee}`), "/Q"], {
      timeout: WINDOWS_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
  }
  // Entries of a DACL that could not be read may still grant someone else.
  if (dacl.parsed) await rememberOwnerOnlyDirectory(target);
}

// For a file the caller has just created. On Windows a file created inside a
// directory restrictToOwner handled in this process inherits that directory's
// owner-only grant at creation, so no tool runs for it.
export async function restrictNewFileToOwner(target, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    // A parent that cannot be identified is not trusted: the file gets its own grant.
    const parent = await directoryIdentity(path.dirname(path.resolve(target))).catch(() => null);
    if (parent && ownerOnlyDirectories.has(parent)) return;
  }
  await restrictToOwner(target, "file", options);
}
