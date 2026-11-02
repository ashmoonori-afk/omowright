// Asserts that paths are readable by their owner only, through whatever the
// platform provides: mode bits on POSIX, and on Windows (where chmod only
// toggles the read-only attribute) a protected DACL whose every entry allows the
// current user. The ACL is read with Get-Acl, independently of the icacls call
// that wrote it.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

// entries: [path, "directory" | "file"] pairs.
export async function assertOwnerOnly(...entries) {
  if (process.platform !== "win32") {
    for (const [target, kind] of entries) {
      assert.equal((await stat(target)).mode & 0o777, kind === "directory" ? 0o700 : 0o600, target);
    }
    return;
  }
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(READ_ACLS, "utf16le").toString("base64")],
    { env: { ...process.env, OWNER_ONLY_PATHS: JSON.stringify(entries.map(([target]) => target)) }, windowsHide: true },
  );
  const { user, acls } = JSON.parse(stdout);
  for (const acl of acls) {
    assert.equal(acl.protected, true, `${acl.path} still inherits its parent's ACL`);
    assert.ok(acl.rules.length > 0, `${acl.path} has an empty ACL`);
    assert.deepEqual(
      acl.rules.filter((rule) => rule.sid !== user || rule.type !== "Allow"),
      [],
      `${acl.path} grants someone other than the current user`,
    );
  }
}
