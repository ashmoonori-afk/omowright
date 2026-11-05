import { dlopen, ptr } from "bun:ffi";
import path from "node:path";

const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
const { symbols } = dlopen(path.win32.join(systemRoot, "System32", "ntdll.dll"), {
  // NTSTATUS is returned in the same native call, unlike GetLastError's
  // thread-local state, whose preservation across FFI/JS is not guaranteed.
  NtCreateFile: {
    args: ["buffer", "u32", "buffer", "buffer", "ptr", "u32", "u32", "u32", "u32", "ptr", "u32"],
    returns: "u32",
  },
  NtClose: { args: ["u64"], returns: "u32" },
  RtlNtStatusToDosError: { args: ["u32"], returns: "u32" },
});

function nativeError(operation, lockPath, status) {
  const error = symbols.RtlNtStatusToDosError(status);
  return Object.assign(
    new Error(`instance lock ${operation} failed for ${lockPath} (Windows error ${error}, NTSTATUS 0x${status.toString(16)})`),
    { code: "ERR_INSTANCE_LOCK" },
  );
}

export function tryAcquireWindows(lockPath) {
  // Bun Windows is 64-bit: UNICODE_STRING has its pointer at offset 8 and
  // OBJECT_ATTRIBUTES is 48 bytes. Translate the Win32 extended namespace to NT.
  const filename = Buffer.from(`${path.toNamespacedPath(path.resolve(lockPath)).replace(/^\\\\\?\\/, "\\??\\")}\0`, "utf16le");
  const name = Buffer.alloc(16);
  name.writeUInt16LE(filename.length - 2, 0);
  name.writeUInt16LE(filename.length, 2);
  name.writeBigUInt64LE(BigInt(ptr(filename)), 8);
  const attributes = Buffer.alloc(48);
  attributes.writeUInt32LE(48, 0);
  attributes.writeBigUInt64LE(BigInt(ptr(name)), 16);
  attributes.writeUInt32LE(0x40, 24); // OBJ_CASE_INSENSITIVE, not OBJ_INHERIT.
  const handleOut = Buffer.alloc(8);
  const ioStatus = Buffer.alloc(16);
  // GENERIC_READ | GENERIC_WRITE | SYNCHRONIZE, share mode 0, FILE_OPEN_IF
  // (OPEN_ALWAYS), synchronous non-directory file. NULL security descriptor
  // inherits the registry's DACL; no truncation, deletion, or inheritance.
  const status = symbols.NtCreateFile(
    handleOut, 0xc0100000, attributes, ioStatus, null, 0x80, 0, 3, 0x60, null, 0,
  );
  // STATUS_SHARING_VIOLATION is exactly ERROR_SHARING_VIOLATION (32).
  if (status === 0xc0000043) return null;
  if (status >= 0x80000000) throw nativeError("NtCreateFile", lockPath, status);
  const handle = handleOut.readBigUInt64LE();
  return {
    release() {
      const status = symbols.NtClose(handle);
      if (status >= 0x80000000) throw nativeError("NtClose", lockPath, status);
    },
  };
}
