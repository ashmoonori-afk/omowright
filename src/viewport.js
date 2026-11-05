export const DEFAULT_AGENT_VIEWPORT = Object.freeze({ width: 1440, height: 900 });

function validateViewport(viewport) {
  if (!viewport || !Number.isInteger(viewport.width) || viewport.width <= 0 || !Number.isInteger(viewport.height) || viewport.height <= 0) throw new TypeError("viewport width and height must be positive integers");
  return { width: viewport.width, height: viewport.height };
}
export async function repinViewport(page, viewport, options = {}) {
  const size = validateViewport(viewport); const sessionId = await page.resolveSessionId();
  await page.cdp.send("Emulation.setDeviceMetricsOverride", { ...size, screenWidth: size.width, screenHeight: size.height, deviceScaleFactor: options.deviceScaleFactor ?? 1, mobile: options.mobile ?? false }, sessionId);
  page.setCachedViewportSize(size); return { ...size };
}
export { validateViewport };
