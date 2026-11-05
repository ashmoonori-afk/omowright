import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

// xnu bsd/sys/fcntl.h: O_EXLOCK and O_NONBLOCK. Node does not export O_EXLOCK.
const DARWIN_EXCLUSIVE_NONBLOCK = 0x20 | 0x4;
// libuv include/uv/win.h: UV_FS_O_EXLOCK makes CreateFile's share mode zero.
const WINDOWS_EXCLUSIVE = 0x10000000;
const probedPaths = new Set();

async function lockLinux(fd) {
  return new Promise((resolve, reject) => {
    const child = spawn("flock", ["-n", "3"], {
      stdio: ["ignore", "ignore", "pipe", fd],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      reject(error.code === "ENOENT"
        ? new Error(`instance lock needs the flock utility (util-linux or busybox) on Linux: ${error.message}`, { cause: error })
        : error);
    });
    // close follows exit and drains stderr, so real utility errors are intact.
    child.once("close", (code, signal) => {
      if (code === 0) resolve(true);
      else if (code === 1) resolve(false);
      else reject(new Error(`instance lock flock failed (${signal ?? code}): ${stderr.trim()}`));
    });
  });
}

export async function tryAcquire(lockPath) {
  const platform = process.platform;
  let flags = constants.O_RDWR | constants.O_CREAT;
  if (platform === "darwin") flags |= DARWIN_EXCLUSIVE_NONBLOCK;
  else if (platform === "win32") flags |= WINDOWS_EXCLUSIVE;
  else if (platform !== "linux") throw new Error(`instance lock is unsupported on ${platform}`);

  let handle;
  try {
    handle = await open(lockPath, flags, 0o600);
  } catch (error) {
    if (platform === "darwin" && ["EAGAIN", "EWOULDBLOCK"].includes(error.code)) return null;
    if (platform === "win32" && error.code === "EBUSY") return null;
    throw error;
  }
  try {
    if (platform === "linux" && !await lockLinux(handle.fd)) {
      await handle.close();
      return null;
    }
  } catch (error) {
    await handle.close();
    throw error;
  }
  // The runtime opens close-on-exec; only the one-shot flock child receives it.
  // Never unlink: another opener must always reach the same kernel object.
  return { release: () => handle.close() };
}

export async function probeOnce(lockPath) {
  if (probedPaths.has(lockPath)) return;
  const second = await tryAcquire(lockPath);
  if (second !== null) {
    await second.release();
    throw new Error(`instance lock is not enforced for ${lockPath} on this runtime and filesystem`);
  }
  probedPaths.add(lockPath);
}
