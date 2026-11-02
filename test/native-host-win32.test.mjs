// Security contract: the Windows ACL policy that decides whether a native-messaging host may be registered. The real
// registration (PowerShell + reg.exe) is exercised on Windows by test/bridge-transport.test.mjs; this table pins the
// policy on every OS so a loosened rights mask or trusted-SID set fails anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isWin32RegistryKey, win32DirectoryChain, win32PathRisk } from "../src/native-host-win32.js";

const USER = "S-1-5-21-1-2-3-1001";
const EVERYONE = "S-1-1-0";
const USERS = "S-1-5-32-545";
const AUTHENTICATED = "S-1-5-11";
const FULL = 0x1f01ff;
const MODIFY = 0x1301bf;
const READ_EXECUTE = 0x1200a9;
const ace = (sid, rights, extra = {}) => ({ sid, rights, allow: true, inheritOnly: false, ...extra });
const base = [ace(USER, FULL), ace("S-1-5-18", FULL), ace("S-1-5-32-544", FULL)];
const dir = (aces = [], extra = {}) => ({ path: "C:\\x", exists: true, directory: true, reparse: false, owner: USER, aces: [...base, ...aces], ...extra });
const exe = (aces = [], extra = {}) => ({ ...dir(aces, extra), path: "C:\\x\\host.cmd", directory: false, ...extra });

test("win32PathRisk accepts only paths no untrusted principal can change, per component kind", () => {
  const cases = [
    ["user-only final dir", dir(), "final", null],
    ["final dir owned by Administrators", dir([], { owner: "S-1-5-32-544" }), "final", null],
    ["final dir owned by another user", dir([], { owner: "S-1-5-21-9-9-9-500" }), "final", /owned by untrusted/],
    ["Everyone Modify on final dir", dir([ace(EVERYONE, MODIFY)]), "final", /grants S-1-1-0/],
    ["inherit-only Everyone Modify on final dir", dir([ace(EVERYONE, MODIFY, { inheritOnly: true })]), "final", null],
    ["deny Everyone Full on final dir", dir([ace(EVERYONE, FULL, { allow: false })]), "final", null],
    ["Users read on final dir", dir([ace(USERS, READ_EXECUTE)]), "final", null],
    ["Users AddSubdirectory on final dir", dir([ace(USERS, 0x4)]), "final", /grants S-1-5-32-545/],
    ["Users AddFile on the host's own dir (DLL planting)", dir([ace(USERS, 0x2)]), "final", /grants S-1-5-32-545/],
    ["(OI)(IO) Users Modify on final dir reaches every new file", dir([ace(USERS, MODIFY, { inheritOnly: true, objectInherit: true })]), "final", /grants S-1-5-32-545/],
    ["(OI)(IO) CREATOR OWNER Full on final dir", dir([ace("S-1-3-0", FULL, { inheritOnly: true, objectInherit: true })]), "final", null],
    ["(OI)(IO) Users Modify on ancestor", dir([ace(USERS, MODIFY, { inheritOnly: true, objectInherit: true })]), "ancestor", null],
    ["unreadable component", { path: "C:\\x", exists: false, inaccessible: true }, "ancestor", /could not be inspected/],
    ["Users AddSubdirectory on ancestor (default C:\\)", dir([ace(USERS, 0x4), ace(AUTHENTICATED, 0x4)]), "ancestor", null],
    ["Users AddFile on ancestor", dir([ace(USERS, 0x2)]), "ancestor", null],
    ["Users DeleteChild on ancestor", dir([ace(USERS, 0x40)]), "ancestor", /grants S-1-5-32-545/],
    ["Authenticated Users Modify on ancestor", dir([ace(AUTHENTICATED, MODIFY)]), "ancestor", /grants S-1-5-11/],
    ["Everyone WRITE_DAC on ancestor", dir([ace(EVERYONE, 0x40000)]), "ancestor", /grants S-1-1-0/],
    ["Everyone GENERIC_ALL on ancestor", dir([ace(EVERYONE, 0x10000000)]), "ancestor", /grants S-1-1-0/],
    ["OWNER RIGHTS write on a trusted-owner dir", dir([ace("S-1-3-4", MODIFY)]), "final", null],
    ["junction ancestor", dir([], { reparse: true }), "ancestor", /reparse point/],
    ["file where a directory is expected", dir([], { directory: false }), "final", /not a directory/],
    ["missing component", { path: "C:\\x", exists: false }, "final", /missing/],
    ["user-owned host.cmd readable by Users", exe([ace(USERS, READ_EXECUTE)]), "executable", null],
    ["host.exe", exe([], { path: "C:\\x\\host.exe" }), "executable", null],
    ["extensionless host", exe([], { path: "C:\\x\\host" }), "executable", /not a \.exe/],
    ["host.ps1", exe([], { path: "C:\\x\\host.ps1" }), "executable", /not a \.exe/],
    ["symlinked host.cmd", exe([], { reparse: true }), "executable", /reparse point/],
    ["directory as host", exe([], { directory: true }), "executable", /not a regular file/],
    ["Authenticated Users Modify on host", exe([ace(AUTHENTICATED, MODIFY)]), "executable", /grants S-1-5-11/],
    ["Everyone GENERIC_WRITE on host", exe([ace(EVERYONE, 0x40000000)]), "executable", /grants S-1-1-0/],
    ["Everyone Delete on host", exe([ace(EVERYONE, 0x10000)]), "executable", /grants S-1-1-0/],
    ["negative generic mask (GENERIC_READ|GENERIC_WRITE) on host", exe([ace(EVERYONE, -1073741824)]), "executable", /grants S-1-1-0/],
    ["manifest readable by Users", exe([ace(USERS, READ_EXECUTE)], { path: "C:\\x\\m.json" }), "manifest", null],
    ["manifest writable by Users", exe([ace(USERS, MODIFY)], { path: "C:\\x\\m.json" }), "manifest", /grants S-1-5-32-545/],
    ["host owned by another user", exe([], { owner: "S-1-5-21-9-9-9-500" }), "executable", /owned by untrusted/],
  ];
  for (const [name, item, kind, expected] of cases) {
    const risk = win32PathRisk(item, kind, USER);
    if (expected === null) assert.equal(risk, null, name);
    else assert.match(risk ?? "", expected, name);
  }
});

test("win32DirectoryChain lists every component from a local drive root and refuses UNC and \\\\?\\ roots", () => {
  assert.deepEqual(win32DirectoryChain("C:\\h\\run\\hosts"), ["C:\\", "C:\\h", "C:\\h\\run", "C:\\h\\run\\hosts"]);
  for (const dir of ["\\\\server\\share\\a", "\\\\?\\C:\\h\\hosts", "\\\\.\\C:\\h"]) assert.throws(() => win32DirectoryChain(dir), /not on a local drive-letter path/, dir);
});

test("isWin32RegistryKey admits only per-user NativeMessagingHosts keys under HKCU\\Software", () => {
  for (const key of ["HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts", "HKCU\\Software\\Chromium\\NativeMessagingHosts", "HKCU\\Software\\t\\NativeMessagingHosts"]) assert.equal(isWin32RegistryKey(key), true, key);
  for (const key of ["HKLM\\Software\\Google\\Chrome\\NativeMessagingHosts", "HKCU\\Software\\Google\\Chrome", "HKCU\\Software", "HKCU\\Environment\\NativeMessagingHosts", "HKCU\\Software\\a\\\\NativeMessagingHosts", "HKCU\\Software\\a\r\nb\\NativeMessagingHosts", undefined]) assert.equal(isWin32RegistryKey(key), false, String(key));
});
