// Asserts that paths are readable by their owner only, through whatever the
// platform provides: mode bits on POSIX, and on Windows (where chmod only
// toggles the read-only attribute) a protected DACL that allows the current user
// and nobody outside the trusted set. SYSTEM, Administrators and TrustedInstaller
// are Windows' root equivalents (root reads a 0600 file too) and are the same
// trusted set the native-host ACL check in src/native-host-win32.js (#102) uses;
// a fresh directory can carry explicit entries for them. The ACL is read with
// Get-Acl, independently of the icacls call that wrote it. An "inherited file"
// is owner-only through its directory's inheritable grant alone: no grant of
// its own, so its ACL is not protected.
// PowerShell runs by absolute path, as the product's Windows tools do.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { windowsSystemTool } from "../../src/owner-only.js";

const execFileAsync = promisify(execFile);
const ROOT_EQUIVALENTS = new Set([
  "S-1-5-18",
  "S-1-5-32-544",
  "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
]);

const READ_ACLS = `
$ErrorActionPreference = 'Stop'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$paths = $env:OWNER_ONLY_PATHS | ConvertFrom-Json
$out = @(foreach ($p in $paths) {
  $acl = Get-Acl -LiteralPath $p
  [pscustomobject]@{
    path = $p
    protected = $acl.AreAccessRulesProtected
    rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
      [pscustomobject]@{ sid = $_.IdentityReference.Value; type = $_.AccessControlType.ToString() }
    })
  }
})
ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{ user = $user; acls = $out })
`;

// entries: [path, "directory" | "file" | "inherited file"] pairs.
export async function assertOwnerOnly(...entries) {
  if (process.platform !== "win32") {
    for (const [target, kind] of entries) {
      assert.equal((await stat(target)).mode & 0o777, kind === "directory" ? 0o700 : 0o600, target);
    }
    return;
  }
  const { stdout } = await execFileAsync(
    windowsSystemTool("WindowsPowerShell\\v1.0\\powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(READ_ACLS, "utf16le").toString("base64")],
    { env: { ...process.env, OWNER_ONLY_PATHS: JSON.stringify(entries.map(([target]) => target)) }, windowsHide: true },
  );
  const { user, acls } = JSON.parse(stdout);
  for (const [index, acl] of acls.entries()) {
    if (entries[index][1] === "inherited file") {
      assert.equal(acl.protected, false, `${acl.path} carries a grant of its own`);
    } else {
      assert.equal(acl.protected, true, `${acl.path} still inherits its parent's ACL`);
    }
    assert.ok(
      acl.rules.some((rule) => rule.sid === user && rule.type === "Allow"),
      `${acl.path} does not grant the current user`,
    );
    assert.deepEqual(
      acl.rules.filter((rule) => rule.type === "Allow" && rule.sid !== user && !ROOT_EQUIVALENTS.has(rule.sid)),
      [],
      `${acl.path} grants someone other than the current user and the system's root equivalents`,
    );
  }
}
