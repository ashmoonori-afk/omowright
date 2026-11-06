import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { removeTreeSync } from "./remove-tree.mjs";

const [mode, shell, ffmpeg] = process.argv.slice(2);
const root = mkdtempSync(path.join(tmpdir(), "omowright-video-failure-"));
const spawn = childProcess.spawn;
let encoder;
let encoderClosed;
let closed = false;
let writesAfterClose = 0;
let endsAfterClose = 0;
// Substitute the encoder command; keep real process, stream and exit behavior.
childProcess.spawn = (command, args, options) => {
  if (command !== "ffmpeg") return spawn(command, args, options);
  // A finite real encoder produces a valid clip and closes stdin before stop().
  // Its exit is the signal; no timing assumptions about screencast delivery.
  // A "stalled" encoder drains its input and keeps running after stdin EOF, like one that hangs while finishing.
  encoder = mode === "early-success"
    ? spawn(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=size=32x32",
      "-frames:v", "1", "-c:v", "libvpx", "-y", args.at(-1)], options)
    : mode === "stalled"
      ? spawn(process.execPath, ["-e", "process.stdin.resume(); setInterval(() => {}, 60000);"], options)
      : spawn(mode === "missing" ? path.join(root, "missing-ffmpeg") : process.execPath, args, options);
  for (const method of ["write", "end"]) {
    const original = encoder.stdin[method];
    encoder.stdin[method] = function (...args) {
      if (this.destroyed || this.writableEnded) {
        if (method === "write") writesAfterClose++;
        else endsAfterClose++;
      }
      return original.apply(this, args);
    };
  }
  encoderClosed = new Promise(resolve => encoder.once("close", () => { closed = true; resolve(); }));
  return encoder;
};
syncBuiltinESMExports();
const { connectPipe, VideoRecordingError } = await import("../../src/index.js");
let connection;
try {
  connection = await connectPipe({
    browserPath: shell,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${root}`],
    storageRoot: root,
  });
  const page = await connection.newTab("about:blank");
  const video = page.video();
  let failure;
  try {
    await video.start({ path: "failed.webm" });
  } catch (error) {
    failure = error;
  }
  if (!failure) {
    // Subscribe in spawn(), then wait for the real early exit before writing; a stalled encoder never exits.
    if (mode !== "stalled") await encoderClosed;
    await page.evaluate(() => { document.body.textContent = "Encoder already exited"; });
    // stop() bounds its wait for the encoder to exit; this deadline only turns an unbounded wait into a failure.
    let deadline;
    try {
      await Promise.race([
        video.stop(),
        new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("video.stop() did not settle within 30000ms")), 30000); }),
      ]);
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(deadline);
    }
  }
  if (mode === "early-success") {
    assert.equal(failure, undefined, "successful encoder exit is not a pipe failure");
    const clip = await video.path();
    const decoded = childProcess.spawnSync(ffmpeg, ["-v", "error", "-i", clip, "-f", "null", "-"]);
    assert.equal(decoded.status, 0, decoded.stderr.toString());
  } else {
    assert.ok(failure, "recording must reject a failed encoder");
    assert.equal(failure.name, "VideoRecordingError", failure.message);
    assert.ok(failure instanceof VideoRecordingError);
  }
  assert.equal(closed, true, "encoder is reaped before recording settles");
  assert.equal(encoder.stdin.destroyed, true, "encoder stdin is closed");
  assert.ok(encoder.exitCode !== null || encoder.signalCode !== null);
  // Only stop()'s bound kills an encoder that never exits by itself.
  if (mode === "stalled") {
    assert.match(failure.message, /ffmpeg did not exit within 10000ms after its input closed; it was killed/);
    assert.equal(encoder.signalCode, "SIGKILL", "the stalled encoder is killed");
  }
  // A spawn that failed ("missing") never had a process; any started encoder must be gone at the OS level.
  if (encoder.pid !== undefined) assert.throws(() => process.kill(encoder.pid, 0), { code: "ESRCH" }, "no encoder process outlives the recording");
  assert.equal(writesAfterClose, 0, "closed encoder input receives no further frames");
  assert.equal(endsAfterClose, 0, "closed encoder input is not ended again");
  if (mode === "early-exit") {
    assert.match(failure.message, /bad option|unknown option|unrecognized option/i);
  }
  console.log(JSON.stringify({ mode, error: failure?.name ?? null, closed }));
} finally {
  // A failed assertion must not leave a live stub holding this host open.
  encoder?.kill("SIGKILL");
  await connection?.close();
  childProcess.spawn = spawn;
  syncBuiltinESMExports();
  removeTreeSync(root);
}
