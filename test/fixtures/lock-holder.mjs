import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { withLock } from "../../src/instance-lock.js";

const [lockPath, ...options] = process.argv.slice(2);

if (lockPath === "--decoy-child") {
  // A real child, like Chromium, that stays alive independently of its parent.
  // The test talks to it after killing the holder, then asks it to shut down.
  const server = createServer((socket) => {
    socket.once("data", (data) => {
      socket.end(`${process.pid}\n`);
      if (data.toString().trim() === "stop") server.close();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  process.stdout.write(`${server.address().port}\n`);
} else {
  const input = createInterface({ input: process.stdin });
  const release = new Promise((resolve) => {
    input.on("line", (line) => { if (line === "release") resolve(); });
  });
  process.stdout.write("WAITING\n");
  try {
    await withLock(lockPath, { timeoutMs: Number(options.find((arg) => arg.startsWith("--timeout="))?.slice(10) ?? 30_000) }, async () => {
      if (options.includes("--decoy")) {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--decoy-child"], {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const lines = createInterface({ input: child.stdout });
        const [port] = await once(lines, "line");
        lines.close();
        child.unref();
        process.stdout.write(`DECOY ${child.pid} ${port}\n`);
      }
      process.stdout.write("HELD\n");
      if (!options.includes("--once")) await release;
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } finally {
    input.close();
    process.stdin.pause();
  }
}
