// Every event page.on / page.off / page.waitForEvent accepts. Each name is delivered by the page or by the module
// that owns it (console-events.js, network-events.js); this is the one public list.
export const PAGE_EVENT_NAMES = Object.freeze([
  "close", "console", "crash", "dialog", "domcontentloaded", "download", "filechooser", "frameattached",
  "framedetached", "framenavigated", "load", "pageerror", "popup", "request", "response",
]);

// Events that need the Runtime domain. Pages can detect Runtime.enable, so the page holds it only while one of
// these has a listener.
export const RUNTIME_PAGE_EVENTS = new Set(["console", "pageerror"]);

export function assertPageEvent(name) {
  if (!PAGE_EVENT_NAMES.includes(name)) {
    throw new TypeError(`Unknown page event: ${String(name)}. Supported events: ${PAGE_EVENT_NAMES.join(", ")}`);
  }
}

function pageError(details = {}) {
  const exception = details.exception ?? {};
  const description = typeof exception.description === "string" ? exception.description : "";
  if (exception.subtype !== "error" || !description) {
    const text = exception.value !== undefined ? String(exception.value) : description || details.text || "Uncaught exception";
    return new Error(text);
  }
  const name = exception.className ?? "Error";
  const head = description.split(/\n\s+at /)[0];
  const error = new Error(head === name ? "" : head.startsWith(`${name}: `) ? head.slice(name.length + 2) : head);
  error.name = name;
  error.stack = description;
  return error;
}

// Runtime.exceptionThrown arrives only while the page holds Runtime for a console or pageerror listener.
export function subscribePageErrors(page) {
  return page.cdp.on("Runtime.exceptionThrown", (event, meta) => {
    if (!meta?.sessionId || !page.frameManager.hasSession(meta.sessionId)) return;
    const details = event.exceptionDetails ?? {};
    // The page's own isolated world is not the page's code.
    for (const frame of page.frameManager.frames.values()) {
      if (frame.sessionId === meta.sessionId && frame.isolatedContextId === details.executionContextId) return;
    }
    page.events.emit("pageerror", pageError(details))
      .catch(error => console.warn("[pageerror] page event listener failed", error));
  });
}
