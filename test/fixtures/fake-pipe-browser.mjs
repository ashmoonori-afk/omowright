// Minimal stand-in for a Chromium launched with --remote-debugging-pipe:
// answers NUL-delimited CDP JSON on fd 3 (read) / fd 4 (write) and emits the
// same startup noise a real macOS Chrome emits on stdout/stderr, including the
// PartitionAlloc shim line (allocator_shim_override_apple_default_zone.h).
// FAKE_SIGNAL_LOG names a file that receives one line per lifecycle event
// ("TERM <epoch ms>", "EOF <epoch ms>"); FAKE_ON_TERM=ignore keeps running
// after SIGTERM (a browser stuck mid-quit), FAKE_ON_TERM=exit quits cleanly.
// FAKE_ON_EOF=ignore keeps running after its CDP pipe closes (a browser that
// outlives its dead caller: the orphan a later launch must reap).
// Like Chrome it quits after answering Browser.close (logged as "CLOSE <epoch
// ms>"); FAKE_ON_CLOSE=ignore keeps it running, a browser that does not quit
// when asked over CDP.
// FAKE_BROWSER_MODE=exit-early logs "START <epoch ms>", prints one stderr line
// and exits 1 before reading its CDP pipe: a browser that cannot start (e.g.
// Chromium's "No usable sandbox!" FATAL). One START line per launch.
import { appendFileSync, createReadStream, createWriteStream, writeSync } from "node:fs";
import { Socket } from "node:net";

const mode = process.env.FAKE_BROWSER_MODE ?? "ready";
const signalLog = process.env.FAKE_SIGNAL_LOG;
const record = (event) => {
  if (signalLog) appendFileSync(signalLog, `${event} ${Date.now()}\n`);
};
if (mode === "exit-early") {
  record("START");
  writeSync(2, "FATAL: fake browser cannot start\n");
  process.exit(1);
}
if (process.env.FAKE_ON_TERM) {
  process.on("SIGTERM", () => {
    record("TERM");
    if (process.env.FAKE_ON_TERM === "exit") process.exit(0);
  });
}

process.stderr.write("Trying to load the allocator multiple times. This is *not* supported.\n");
process.stdout.write("fake-browser stdout noise\n");

if (mode === "mute-cdp") {
  process.stderr.write("BOOM diagnostics 123\n");
  setInterval(() => {}, 60_000); // stay alive, never answer CDP
} else {
  // Under node, a non-blocking socket: fs.createReadStream parks a threadpool
  // thread in a blocking read on the pipe, which holds process.exit() in the
  // SIGTERM handler. Bun's net.Socket does not read an inherited pipe fd.
  const input = typeof Bun === "undefined"
    ? new Socket({ fd: 3, readable: true, writable: false })
    : createReadStream(null, { fd: 3 });
  const output = createWriteStream(null, { fd: 4 });
  let buffer = Buffer.alloc(0);
  input.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let idx;
    while ((idx = buffer.indexOf(0)) !== -1) {
      const raw = buffer.subarray(0, idx).toString("utf8");
      buffer = buffer.subarray(idx + 1);
      if (raw.length === 0) continue;
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      if (msg.method === "Browser.close") {
        record("CLOSE");
        output.write(JSON.stringify({ id: msg.id, result: {} }) + "\0", () => {
          if (process.env.FAKE_ON_CLOSE !== "ignore") process.exit(0);
        });
        continue;
      }
      const result = msg.method === "Browser.getVersion"
        ? { product: "FakeChrome/1.0", protocolVersion: "1.3" }
        : {};
      output.write(JSON.stringify({ id: msg.id, result }) + "\0");
    }
  });
  input.on("end", () => {
    record("EOF");
    if (process.env.FAKE_ON_EOF === "ignore") setInterval(() => {}, 60_000);
    else process.exit(0);
  });
}
