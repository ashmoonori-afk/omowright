import { rmSync } from "node:fs";

// Removes a directory tree that a just-exited browser may still hold. Chrome's
// helper processes keep profile files open briefly after the browser process
// exits, which Windows reports as EBUSY/EPERM. Node's rmSync retries those
// through maxRetries, but Bun's rmSync ignores maxRetries and throws on the
// first attempt, so this retries the same codes with the same linear backoff
// as Node (100 ms x attempt, 10 retries) under both runners.
const RETRYABLE = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]);
const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 100;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

export function removeTreeSync(dir) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!RETRYABLE.has(error?.code) || attempt > MAX_RETRIES) throw error;
      Atomics.wait(sleeper, 0, 0, RETRY_DELAY_MS * attempt);
    }
  }
}
