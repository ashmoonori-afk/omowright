import { dlopen } from "bun:ffi";
import path from "node:path";

const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
const { symbols } = dlopen(path.win32.join(systemRoot, "System32", "kernel32.dll"), {
  // HANDLE is an integer token, not an address: Bun FFI requires u64, not ptr.
  CreateFileW: {
    args: ["buffer", "u32", "u32", "ptr", "u32", "u32", "u64"],
    returns: "u64",
  },
  CloseHandle: { args: ["u64"], returns: "i32" },
  GetLastError: { args: [], returns: "u32" },
});

export function tryAcquireWindows(lockPath) {
  const filename = Buffer.from(`${path.toNamespacedPath(lockPath)}\0`, "utf16le");
  // GENERIC_READ | GENERIC_WRITE, no sharing, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL.
  // NULL security attributes make the handle non-inheritable and the new file
  // inherits its registry directory's owner-only DACL. Never truncate or unlink.
  const handle = symbols.CreateFileW(filename, 0xc0000000, 0, null, 4, 0x80, 0n);
  if (handle === 0xffffffffffffffffn) {
    const error = symbols.GetLastError();
    if (error === 32 || error === 33) return null;
    throw new Error(`instance lock CreateFileW failed for ${lockPath} (Windows error ${error})`);
  }
  return {
    release() {
      if (!symbols.CloseHandle(handle)) {
        throw new Error(`instance lock CloseHandle failed for ${lockPath} (Windows error ${symbols.GetLastError()})`);
      }
    },
  };
}
