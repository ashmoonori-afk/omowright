export async function captureScreenshot(session, { ref, tabId, fullPage = false, scope, timeoutMs, context, dependsOn } = {}) {
  if (!fullPage) {
    const result = await session.tool("screenshot", { ref, tab_id: tabId });
    return {
      buffer: Buffer.from(result.image_base64, "base64"),
      width: result.width,
      height: result.height,
      format: result.format,
      captureId: result.capture_id ?? null,
      captureUnavailable: result.capture_unavailable ?? null,
      tabId: result.tab_id,
      dialogs: result.dialogs ?? [],
    };
  }
  const started = await session.tool("screenshot_full_page", { scope, tab_id: tabId, timeout_ms: timeoutMs, context_id: context, depends_on: dependsOn });
  const buffer = await readCapture(session, started.capture_id, started.byte_size);
  return {
    buffer,
    width: started.width,
    height: started.height,
    format: started.format,
    captureId: started.capture_id,
    scope: started.scope ?? scope ?? null,
    tabId: started.tab_id,
    dialogs: started.dialogs ?? [],
  };
}

async function readCapture(session, captureId, byteSize) {
  const chunks = [];
  let offset = 0;
  try {
    for (;;) {
      const chunk = await session.tool("screenshot_read", { capture_id: captureId, offset });
      const bytes = Buffer.from(chunk.data_base64 ?? "", "base64");
      chunks.push(bytes);
      if (chunk.eof || bytes.length === 0) break;
      if (chunk.next_offset <= offset) throw new Error(`screenshot_read did not advance past offset ${offset}`);
      offset = chunk.next_offset;
    }
  } finally {
    await session.tool("screenshot_release", { capture_id: captureId }).catch(() => {});
  }
  const buffer = Buffer.concat(chunks);
  if (typeof byteSize === "number" && buffer.length !== byteSize) {
    throw new Error(`screenshot capture ${captureId}: expected ${byteSize} bytes, assembled ${buffer.length}`);
  }
  return buffer;
}
