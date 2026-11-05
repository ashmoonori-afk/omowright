import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { removeTreeSync } from "./remove-tree.mjs";

const [mode, shell] = process.argv.slice(2);
const root = mkdtempSync(path.join(tmpdir(), "omowright-video-failure-"));
const spawn = childProcess.spawn;
let encoder;
let encoderClosed;
let closed = false;
// Change only executable selection; keep real process, stream and exit behavior.
childProcess.spawn = (command, args, options) => {
  if (command !== "ffmpeg") return spawn(command, args, options);
  encoder = spawn(mode === "missing" ? path.join(root, "missing-ffmpeg") : process.execPath, args, options);
  encoderClosed = new Promise(resolve => encoder.once("close", () => { closed = true; resolve(); }));
  return encoder;
};
syncBuiltinESMExports();
const { connectPipe, VideoRecordingError } = await import("../../src/index.js");
const connection = await connectPipe({
  browserPath: shell,
  browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${root}`],
  storageRoot: root,
});
try {
  const page = await connection.newTab("about:blank");
  const video = page.video();
  let failure;
  try {
    await video.start({ path: "failed.webm" });
  } catch (error) {
    failure = error;
  }
  if (!failure) {
    // Subscribe in spawn(), then wait for the real early exit before writing.
    await encoderClosed;
    await page.evaluate(() => { document.body.textContent = "Encoder already exited"; });
    try {
      await video.stop();
    } catch (error) {
      failure = error;
    }
  }
  assert.ok(failure, "recording must reject a failed encoder");
  assert.equal(failure.name, "VideoRecordingError");
  assert.ok(failure instanceof VideoRecordingError);
  assert.equal(closed, true, "encoder is reaped before recording rejects");
  assert.equal(encoder.stdin.destroyed, true, "encoder stdin is closed");
  assert.ok(encoder.exitCode !== null || encoder.signalCode !== null);
  console.log(JSON.stringify({ mode, error: failure.name, closed }));
} finally {
  await connection.close();
  childProcess.spawn = spawn;
  syncBuiltinESMExports();
  removeTreeSync(root);
}
