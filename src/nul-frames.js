// Reassembles NUL-delimited frames (the CDP pipe's framing) from stream chunks.
// Only the newly arrived chunk is scanned for the delimiter, and a frame that
// spans chunks is joined once, when its delimiter arrives, so receiving costs
// one copy of each byte. Re-copying the pending bytes on every chunk made a
// large reply quadratic in its size (#237).
export class NulFrameReader {
  #parts = [];

  // Returns the frames that chunk completes, decoded as UTF-8, empty ones included.
  push(chunk) {
    const frames = [];
    let start = 0;
    let end;
    while ((end = chunk.indexOf(0, start)) !== -1) {
      const tail = chunk.subarray(start, end);
      let frame = tail;
      if (this.#parts.length > 0) {
        this.#parts.push(tail);
        frame = Buffer.concat(this.#parts);
        this.#parts = [];
      }
      frames.push(frame.toString("utf8"));
      start = end + 1;
    }
    if (start < chunk.length) this.#parts.push(chunk.subarray(start));
    return frames;
  }
}
