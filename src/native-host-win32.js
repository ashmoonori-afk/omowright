// Windows half of native-messaging host registration (#90 cluster 3). Chrome on Windows finds a host through the
// per-user registry value HKCU\Software\<vendor>\<browser>\NativeMessagingHosts\<name> (default value = manifest path),
// and file safety lives in the owner SID and ACL, not in uid/mode bits. The policy below is the ACL analogue of the
// POSIX checks in bridge-transport.js: only the user, SYSTEM, Administrators and TrustedInstaller may be able to
// change the host executable, the directory it starts in, the manifest or its directory, or replace any directory on
// the path to them. For a .cmd/.bat host only the wrapper and its directory are covered, not what the script runs.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

const SYSTEM = "S-1-5-18";
const ADMINISTRATORS = "S-1-5-32-544";
const TRUSTED_INSTALLER = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
const OWNER_RIGHTS = "S-1-3-4";
const CREATOR_OWNER = "S-1-3-0";

// FileSystemRights bits (winnt.h). Directory names in brackets.
const WRITE_DATA = 0x2; // [AddFile]
const APPEND_DATA = 0x4; // [AddSubdirectory]
const WRITE_EA = 0x10;
const DELETE_CHILD = 0x40;
const WRITE_ATTRIBUTES = 0x100;
const DELETE = 0x10000;
const WRITE_DAC = 0x40000;
const WRITE_OWNER = 0x80000;
const GENERIC_ALL = 0x10000000;
const GENERIC_WRITE = 0x40000000;

// Rights that let a principal change an object's content, metadata, ACL or owner, or delete it.
const MODIFY = WRITE_DATA | APPEND_DATA | WRITE_EA | WRITE_ATTRIBUTES | DELETE | WRITE_DAC | WRITE_OWNER | GENERIC_ALL | GENERIC_WRITE;
// What an untrusted principal must not hold on each kind of path component. "final" is a directory whose content
// matters: the manifest directory, and the host's own directory (Chrome starts the host there, so an .exe loads DLLs
// and a .cmd resolves bare commands from it).
const FORBIDDEN = {
  executable: MODIFY,
  manifest: MODIFY,
  final: MODIFY | DELETE_CHILD,
  // An ancestor may let others add entries (default C:\ grants Users AddSubdirectory, the analogue of a sticky root
  // /tmp), but nobody untrusted may delete or rename an existing child, delete the ancestor, or take its ACL.
  ancestor: DELETE_CHILD | DELETE | WRITE_DAC | WRITE_OWNER | GENERIC_ALL,
};

export const WIN32_REGISTRY_KEYS = Object.freeze({
  chrome: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts",
  chromium: "HKCU\\Software\\Chromium\\NativeMessagingHosts",
});

export const isWin32RegistryKey = (key) => typeof key === "string" && /^HKCU\\Software(\\[^\\/:*?"<>|\r\n]+)*\\NativeMessagingHosts$/i.test(key);

// Returns null when the inspected path is safe as `kind` ("executable", "manifest", "final" or "ancestor"), else the
// reason. `item` is one entry of inspectWin32Paths(); `userSid` is the current user's SID.
export function win32PathRisk(item, kind, userSid) {
  const trusted = new Set([userSid, SYSTEM, ADMINISTRATORS, TRUSTED_INSTALLER]);
  if (item?.inaccessible) return "could not be inspected";
  if (!item?.exists) return "is missing";
  if (item.reparse) return "is a symlink, junction or other reparse point";
  if (kind === "executable" || kind === "manifest") {
    if (item.directory) return "is not a regular file";
    if (kind === "executable" && !/\.(exe|cmd|bat|com)$/i.test(item.path)) return "is not a .exe, .cmd, .bat or .com file";
  } else if (!item.directory) return "is not a directory";
  if (!trusted.has(item.owner)) return `is owned by untrusted ${item.owner}`;
  trusted.add(OWNER_RIGHTS).add(CREATOR_OWNER); // OWNER RIGHTS = the (trusted) owner; CREATOR OWNER = whoever creates a child
  for (const ace of item.aces ?? []) {
    if (!ace.allow || trusted.has(ace.sid)) continue;
    // An inherit-only ACE does not apply to this object, but on a final directory an object-inheriting one lands on
    // every file created in it (the manifest, a DLL next to the host), so it counts with the file rights.
    const mask = !ace.inheritOnly ? FORBIDDEN[kind] : kind === "final" && ace.objectInherit ? MODIFY : 0;
    if ((Number(ace.rights) & mask) !== 0) return `grants ${ace.sid} write access`;
  }
  return null;
}

const systemBinary = (...segments) => {
  const file = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", ...segments);
  if (!existsSync(file)) throw new Error(`${file} is missing`);
  return file;
};

// Exit code of a finished child; a spawn failure, a timeout or a kill rejects (the caller fails closed).
function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && (typeof error.code !== "number" || error.killed)) reject(error);
      else resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

// One bounded PowerShell call that reports, for each path in order: whether it exists or could not be read, whether it
// is a directory or a reparse point, its owner SID and its ACEs (SID, allow/deny, rights mask, inherit-only,
// object-inherit); plus the current user SID. Paths travel base64-encoded inside the script and nothing path-shaped
// comes back, so no console code page can garble them. Under Constrained Language Mode the .NET calls fail, and so
// does the whole inspection: the caller fails closed.
const INSPECT = `$ErrorActionPreference = 'Stop'
$paths = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PATHS__')))
$sid = [System.Security.Principal.SecurityIdentifier]
$items = @(foreach ($p in $paths) {
  try { $i = Get-Item -LiteralPath $p -Force; $acl = Get-Acl -LiteralPath $p }
  catch [System.Management.Automation.ItemNotFoundException] { [pscustomobject]@{ exists = $false; inaccessible = $false }; continue }
  catch { [pscustomobject]@{ exists = $false; inaccessible = $true }; continue }
  $aces = @(foreach ($r in $acl.GetAccessRules($true, $true, $sid)) { [pscustomobject]@{
    sid = $r.IdentityReference.Value; allow = ($r.AccessControlType -eq 'Allow'); rights = [int64]$r.FileSystemRights
    inheritOnly = (($r.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0)
    objectInherit = (($r.InheritanceFlags -band [System.Security.AccessControl.InheritanceFlags]::ObjectInherit) -ne 0) } })
  [pscustomobject]@{ exists = $true; inaccessible = $false; directory = [bool]$i.PSIsContainer; owner = $acl.GetOwner($sid).Value
    aces = $aces; reparse = (($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) }
})
ConvertTo-Json -Depth 6 -Compress @{ user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; items = $items }`;

export async function inspectWin32Paths(paths) {
  let out;
  try {
    const script = INSPECT.replace("__PATHS__", Buffer.from(JSON.stringify(paths), "utf8").toString("base64"));
    const powershell = systemBinary("WindowsPowerShell", "v1.0", "powershell.exe");
    const result = await run(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
    if (result.code !== 0) throw new Error(String(result.stderr).trim() || `exit ${result.code}`);
    out = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`native host security could not be verified (the PowerShell ACL inspection failed; Constrained Language Mode or a policy may block it): ${error.message}`);
  }
  const items = [out.items ?? []].flat();
  if (typeof out.user !== "string" || items.length !== paths.length) throw new Error("native host security could not be verified: unexpected ACL report");
  return { user: out.user, items: items.map((item, index) => ({ ...item, path: paths[index], aces: [item.aces ?? []].flat() })) };
}

// Every directory from the drive root down to `dir`, root first. Only local drive-letter paths are accepted: a UNC or
// \\?\ root has an ACL this host does not own and cannot be walked the same way.
export function win32DirectoryChain(dir) {
  const absolute = path.win32.resolve(dir);
  const { root } = path.win32.parse(absolute);
  if (!/^[A-Za-z]:\\$/.test(root) || /^\\\\/.test(dir)) throw new Error(`${dir} is not on a local drive-letter path`);
  const chain = [root];
  for (const part of absolute.slice(root.length).split("\\").filter(Boolean)) chain.push(path.win32.join(chain.at(-1), part));
  return chain;
}

async function registryDefault(key, view) {
  const result = await run(systemBinary("reg.exe"), ["query", key, "/ve", ...(view ? [`/reg:${view}`] : [])]);
  if (result.code !== 0) return null;
  return /REG_SZ\s+(.*?)\s*$/m.exec(result.stdout)?.[1] ?? "";
}

// Verifies the host and the manifest directory, writes the manifest through `writeManifest(file)` (the shared atomic
// writer), re-verifies the written file, then points the per-user registry value at it.
export async function installWin32NativeHost({ hostName, hostPath, dir, registryKey, force, writeManifest }) {
  const hostChain = win32DirectoryChain(path.win32.dirname(hostPath));
  win32DirectoryChain(hostPath);
  const dirChain = win32DirectoryChain(dir);
  const { user, items } = await inspectWin32Paths([hostPath, ...hostChain, ...dirChain]);
  const reject = (prefix, item, kind) => { const risk = win32PathRisk(item, kind, user); if (risk) throw new Error(`${prefix}: ${item.path} ${risk}`); };
  const kindAt = (chain, index) => (index === chain.length - 1 ? "final" : "ancestor");
  reject("hostPath must be a securely owned executable file", items[0], "executable");
  items.slice(1, 1 + hostChain.length).forEach((item, index) => reject("hostPath directory security rejected", item, kindAt(hostChain, index)));
  const dirItems = items.slice(1 + hostChain.length);
  const firstMissing = dirItems.findIndex((item) => !item.exists && !item.inaccessible);
  dirItems.slice(0, firstMissing === -1 ? undefined : firstMissing).forEach((item, index) => reject("nativeMessagingHostDir security rejected", item, kindAt(dirChain, index)));
  if (firstMissing === 0) throw new Error(`nativeMessagingHostDir security rejected: ${dirChain[0]} is missing`);
  if (firstMissing > 0) {
    const created = dirChain.slice(firstMissing);
    await mkdir(dirChain.at(-1), { recursive: true });
    try {
      const again = await inspectWin32Paths(created);
      if (again.user !== user) throw new Error("native host security could not be verified: user changed");
      again.items.forEach((item, offset) => reject("nativeMessagingHostDir security rejected", item, kindAt(dirChain, firstMissing + offset)));
    } catch (error) {
      for (const made of created.reverse()) await rmdir(made).catch(() => {});
      throw error;
    }
  }
  const file = path.win32.join(dirChain.at(-1), `${hostName}.json`);
  const hostKey = `${registryKey}\\${hostName}`;
  const current = await registryDefault(hostKey);
  if (current !== null && current.toLowerCase() !== file.toLowerCase() && !force) throw new Error(`${hostKey} already points at ${current}; use force`);
  const manifest = await writeManifest(file);
  const written = await inspectWin32Paths([file]);
  const manifestRisk = win32PathRisk(written.items[0], "manifest", user);
  // On a force reinstall the HKCU value may already name this path; it then points at a missing file, which Chrome
  // treats as no host, and nobody untrusted can recreate the file in the verified directory.
  if (manifestRisk) { await unlink(file).catch(() => {}); throw new Error(`native messaging manifest security rejected: ${file} ${manifestRisk}`); }
  const added = await run(systemBinary("reg.exe"), ["add", hostKey, "/ve", "/t", "REG_SZ", "/d", file, "/f"]);
  if (added.code !== 0) throw new Error(`native host registry write failed: ${String(added.stderr).trim()}`);
  const machineKey = `HKLM\\${hostKey.slice("HKCU\\".length)}`;
  for (const view of ["32", "64"]) {
    if (await registryDefault(machineKey, view) !== null) throw new Error(`${hostKey} is shadowed by a machine-level registration at ${machineKey} (/reg:${view})`);
  }
  return { path: file, manifest, registryKey: hostKey };
}
