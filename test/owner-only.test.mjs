// Contract owner: the Windows owner-only hardening (security contract). The
// Windows tools run by absolute System32 path, so a cwd another user can write
// cannot substitute them, and every failure throws, so no caller goes on with
// the inherited ACL. Test seam: the platform and the spawner are injected so
// the win32 branch runs off Windows; the ACL that results on a real Windows host
// is asserted by the cloak-profile and instances tests through Get-Acl.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { restrictToOwner, windowsSystemTool } from "../src/owner-only.js";

const SID = "S-1-5-21-1-2-3-1001";

function spawner({ whoami = `"host\\me","${SID}"\r\n`, icacls } = {}) {
  const calls = [];
  const run = async (file, args) => {
    calls.push({ file, args });
    if (file.endsWith("whoami.exe")) return { stdout: whoami, stderr: "" };
    if (icacls) throw icacls;
    return { stdout: "", stderr: "" };
  };
  return { calls, run };
}

test("windowsSystemTool resolves under SystemRoot, then windir, then C:\\Windows", () => {
  assert.equal(windowsSystemTool("icacls.exe", { SystemRoot: "D:\\Win" }), "D:\\Win\\System32\\icacls.exe");
  assert.equal(windowsSystemTool("icacls.exe", { windir: "E:\\W" }), "E:\\W\\System32\\icacls.exe");
  assert.equal(windowsSystemTool("icacls.exe", {}), "C:\\Windows\\System32\\icacls.exe");
});

test("restrictToOwner on win32 runs whoami and icacls by absolute path with an owner-only grant", async () => {
  const { calls, run } = spawner();
  await restrictToOwner("C:\\data\\profile", "directory", { platform: "win32", run });
  await restrictToOwner("C:\\data\\profile\\seed.json", "file", { platform: "win32", run });
  for (const { file } of calls) assert.ok(path.win32.isAbsolute(file), `${file} is not an absolute path`);
  assert.deepEqual(
    calls.filter(({ file }) => file === windowsSystemTool("icacls.exe")).map(({ args }) => args),
    [
      ["C:\\data\\profile", "/inheritance:r", "/grant:r", `*${SID}:(OI)(CI)F`, "/Q"],
      ["C:\\data\\profile\\seed.json", "/inheritance:r", "/grant:r", `*${SID}:F`, "/Q"],
    ],
  );
  assert.ok(calls.some(({ file }) => file === windowsSystemTool("whoami.exe")));
});

test("restrictToOwner on win32 fails closed when a tool is missing, fails, or names no SID", async () => {
  const missing = Object.assign(new Error("spawn icacls.exe ENOENT"), { code: "ENOENT" });
  await assert.rejects(restrictToOwner("C:\\p", "file", { platform: "win32", run: spawner({ icacls: missing }).run }), /ENOENT/);
  const exited = Object.assign(new Error("Command failed: icacls.exe"), { code: 5 });
  await assert.rejects(restrictToOwner("C:\\p", "file", { platform: "win32", run: spawner({ icacls: exited }).run }), /Command failed/);
  const noSid = spawner({ whoami: "INFO: no user\r\n" });
  await assert.rejects(restrictToOwner("C:\\p", "file", { platform: "win32", run: noSid.run }), /SID/);
  assert.equal(noSid.calls.some(({ file }) => file.endsWith("icacls.exe")), false);
});
