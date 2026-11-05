import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { PipeCdpClient } from "../src/index.js";
import { NulFrameReader } from "../src/nul-frames.js";

const failureBrowser = fileURLToPath(new URL("./fixtures/pipe-failures-browser.mjs", import.meta.url));

// Protects the receive cost of the CDP pipe (#237): a reply is reassembled with
// one copy of its bytes. Re-copying the pending buffer on every chunk made a
// 35 MB page.pdf() reply quadratic in its size.
test("a pipe reply spanning many chunks is copied once, not once per chunk", { timeout: 60_000 }, async t => {
  const client = new PipeCdpClient({ browserPath: process.execPath, browserArgs: [failureBrowser], logId: "pipe-frames-test" });
  t.after(() => client.close());
  await client.ensureConnected();
  // Far larger than one pipe read (64 KiB on Linux and macOS), so it arrives in many chunks.
  const bytes = 8 << 20;
  const frameBytes = Buffer.byteLength(JSON.stringify({ id: 0, result: { data: "" } })) + bytes;
  const concat = Buffer.concat;
  let copied = 0;
  Buffer.concat = function (list, totalLength) {
    const out = concat.call(this, list, totalLength);
    copied += out.length;
    return out;
  };
  let result;
  try {
    result = await client.send("Fixture.large", { bytes });
  } finally {
    Buffer.concat = concat;
  }
  assert.equal(result.data.length, bytes);
  assert.ok(/^x*$/.test(result.data), "the reassembled reply lost or reordered bytes");
  assert.ok(copied <= 2 * frameBytes, `copied ${copied} bytes to receive a ${frameBytes}-byte frame`);
});

// Chunk boundaries the OS pipe does not let a test place: each row is the chunks
// as they arrive and the frames each push must complete.
const eAcute = Buffer.from("\u00e9");
for (const [name, chunks, frames] of [
  ["delimiter alone at the start of the next chunk", ["{\"id\":1}", "\0"], [[], ["{\"id\":1}"]]],
  ["delimiter as the last byte of a chunk", ["{\"id\"", ":1}\0", "{}\0"], [[], ["{\"id\":1}"], ["{}"]]],
  ["several frames and a partial tail in one chunk", ["a\0b\0c", "d\0"], [["a", "b"], ["cd"]]],
  ["a frame spanning three chunks", ["a", "b", "c\0"], [[], [], ["abc"]]],
  ["empty chunks and empty frames", ["", "a", "", "\0\0", ""], [[], [], [], ["a", ""], []]],
  ["a UTF-8 character split across chunks", [eAcute.subarray(0, 1), Buffer.concat([eAcute.subarray(1), Buffer.from([0])])], [[], ["\u00e9"]]],
]) {
  test(`pipe frames: ${name}`, () => {
    const reader = new NulFrameReader();
    assert.deepEqual(chunks.map(chunk => reader.push(Buffer.from(chunk))), frames);
  });
}
