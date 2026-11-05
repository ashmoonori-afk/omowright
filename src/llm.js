const SNAPSHOT_PARSE_ERROR =
  "compactSnapshot expected a snapshot() result (JSON string or {tree, refs} object)";

export function compactSnapshot(snapshot) {
  const obj = typeof snapshot === "string" ? JSON.parse(snapshot) : snapshot;
  if (obj?.full === false && obj.diff) {
    const { added, changed, removed, focused } = obj.diff;
    const lines = [
      ...added.map(node => `+ ${node.tree}`),
      ...changed.map(node => `~ ${node.tree}`),
    ];
    if (removed.length) lines.push(`- ${refRanges(removed)}`);
    lines.push(`@focused ${focused ?? "none"}`);
    return lines.join("\n");
  }
  if (!obj || typeof obj.tree !== "string") throw new TypeError(SNAPSHOT_PARSE_ERROR);
  return obj.tree;
}

function refRanges(refs) {
  const sorted = refs.map(ref => {
    const [, prefix, number] = /^((?:f\d+)?e)(\d+)$/.exec(ref);
    return { prefix, number: Number(number) };
  }).sort((a, b) => a.prefix.localeCompare(b.prefix) || a.number - b.number);
  const ranges = [];
  for (let i = 0; i < sorted.length; i++) {
    const first = sorted[i];
    let last = first;
    while (sorted[i + 1]?.prefix === first.prefix && sorted[i + 1].number === last.number + 1) last = sorted[++i];
    ranges.push(first === last ? `${first.prefix}${first.number}` : `${first.prefix}${first.number}-${last.prefix}${last.number}`);
  }
  return ranges.join(", ");
}

export function snapshotTokens(snapshot) {
  const text = typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot);
  return { bytes: Buffer.byteLength(text, "utf8"), estTokens: Math.ceil(Buffer.byteLength(text, "utf8") / 4) };
}

export const toolSchemas = [
  {
    name: "newTab",
    description: "Open a tab and return its page. Waits for interactivity.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "attachPage",
    description: "Attach to an existing tab by targetId from listTargets().",
    parameters: { type: "object", properties: { targetId: { type: "string" } }, required: ["targetId"] },
  },
  {
    name: "page.goto",
    description: "Navigate the page; resolves when the page looks interactive.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "page.snapshot",
    description: "PRIMARY page read. Snapshot once, act on refs, then use {diff:true} for changes. Full fallbacks carry full:true and a reason. Options: diff, maxDepth, maxChars, interactive, showHidden, selector, ref.",
    parameters: { type: "object", properties: { options: { type: "object" } } },
  },
  {
    name: "page.locator",
    description: "Resolve a ref id (e.g. 'e1') or CSS selector to a Locator: click, fill, press, hover, check, selectOption, dragTo, setInputFiles, textContent, isVisible, waitFor.",
    parameters: { type: "object", properties: { selectorOrRef: { type: "string" } }, required: ["selectorOrRef"] },
  },
  {
    name: "page.evaluate",
    description: "Run JS in the page and return the result.",
    parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"] },
  },
  {
    name: "page.screenshot",
    description: "Capture page image bytes (path, fullPage, clip, type, quality).",
    parameters: { type: "object", properties: { options: { type: "object" } } },
  },
  {
    name: "page.pdf",
    description: "Print the page to PDF bytes (path, format, margin, printBackground).",
    parameters: { type: "object", properties: { options: { type: "object" } } },
  },
  {
    name: "compactSnapshot",
    description: "Compact page.snapshot() before reading: full results become raw trees; diffs use +/~ lines and removed ref ranges. Refs resolve in-page.",
    parameters: { type: "object", properties: { snapshot: {} }, required: ["snapshot"] },
  },
  {
    name: "createCua",
    description: "Coordinate fallback for UI that refs cannot target: click/doubleClick/drag/move/scroll/type/keypress at viewport points, getVisibleScreenshot() as base64 PNG.",
    parameters: { type: "object", properties: { page: {} }, required: ["page"] },
  },
  {
    name: "createCaptcha",
    description: "Captcha helpers: click(bounds) and drag(from,to) return a post-action snapshot tree; readText(bounds?) OCRs a screenshot region (macOS Vision default, custom ocr injectable).",
    parameters: { type: "object", properties: { page: {}, options: { type: "object" } }, required: ["page"] },
  },
  {
    name: "createChromeApi",
    description: "Chrome MV3-shaped APIs: tabs.query/get, windows.*, bookmarks/history/topSites (read-only from profile files), downloads.search/download. Writes throw UnsupportedOperationError.",
    parameters: { type: "object", properties: { connection: {}, options: { type: "object" } }, required: ["connection"] },
  },
  {
    name: "injectCookies",
    description: "Inject raw cookie exports into a page with CDP sanitization handled (negative expires dropped, __Host- forced secure+root path+url-scoped, SameSite=None dropped when not secure, name+domain deduped).",
    parameters: { type: "object", properties: { page: {}, cookies: { type: "array" } }, required: ["page", "cookies"] },
  },
  {
    name: "createNetworkSnoop",
    description: "Buffer a page's CDP network traffic and return {pop,peek,popJson,waitFor,summary,dispose}; match is a predicate or {url,method,mimeType,resourceType}.",
    parameters: { type: "object", properties: { page: {}, match: {}, bodies: { type: "boolean" }, maxEntries: { type: "number" }, maxBodyBytes: { type: "number" } }, required: ["page"] },
  },
  {
    name: "snoop.waitFor",
    description: "Wait until a finished entry matches a predicate or {url,method,mimeType,resourceType}; timeoutMs defaults to 30000.",
    parameters: { type: "object", properties: { match: {}, timeoutMs: { type: "number" } } },
  },
  {
    name: "snoop.popJson",
    description: "Drain the buffer and parse JSON bodies; skips non-JSON mime types and payloads that fail to parse.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "snoop.summary",
    description: "Return a compact text view of buffered entries (method, status, mimeType, size, url) capped by {max}.",
    parameters: { type: "object", properties: { max: { type: "number" } } },
  },
  {
    name: "collectWhileScrolling",
    description: "Async generator that scrolls the page, drains snoop.popJson(), and yields extracted items until minItems, maxScrolls, or noGrowth.",
    parameters: { type: "object", properties: { page: {}, snoop: {}, minItems: { type: "number" }, maxScrolls: { type: "number" }, extract: {}, scroll: { type: "string", enum: ["wheel", "end"] }, settleMs: { type: "number" } }, required: ["page", "snoop"] },
  },
  {
    name: "createTrace",
    description: "Start a page flight recorder that writes dir/trace.jsonl, dir/trace.har, dir/summary.json and screenshots; never sends Runtime.enable.",
    parameters: { type: "object", properties: { page: {}, dir: { type: "string" }, screenshots: { type: "boolean" }, network: { type: "boolean" }, console: { type: "boolean" }, maxBodyBytes: { type: "number" }, events: {} }, required: ["page", "dir"] },
  },
  {
    name: "trace.step",
    description: "Run named fn as a traced step with optional before/after screenshots; records the error and rethrows on failure.",
    parameters: { type: "object", properties: { name: { type: "string" }, fn: {} }, required: ["name", "fn"] },
  },
  {
    name: "trace.stop",
    description: "Flush listeners, write summary.json and trace.har, dispose the snoop, and return the summary for dir.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "reconcileFrames",
    description: "Adopt OOPIF iframe targets missing from FrameManager so later snapshots include them; returns the frames that were added.",
    parameters: { type: "object", properties: { page: {} }, required: ["page"] },
  },
  {
    name: "snapshotWithFrames",
    description: "Reconcile missing OOPIF frames then snapshot; refs stay page-level: page.locator(ref), never frame.locator.",
    parameters: { type: "object", properties: { page: {}, options: { type: "object" } }, required: ["page"] },
  },
  {
    name: "connectPipe.dialogPolicy",
    description: "Wire connectPipe({dialogPolicy}), connect(url, {dialogPolicy}) and setDialogPolicy to {accept,promptText} or (dialog)=>boolean|{accept,promptText}; a throwing policy accepts.",
    parameters: { type: "object", properties: { accept: { type: "boolean" }, promptText: { type: "string" } } },
  },
  {
    name: "requestHuman",
    description: "Pause for a human: inject a shadow-DOM Done banner, bringToFront first, and remove the banner on every path; until is {url}|{selector}|async predicate.",
    parameters: { type: "object", properties: { page: {}, prompt: { type: "string" }, until: {}, timeoutMs: { type: "number" }, pollMs: { type: "number" }, signal: {} }, required: ["page"] },
  },
  {
    name: "describeLayers",
    description: "Sample a viewport grid and return {blocking,candidates,viewport} so overlay coverage and selectorHint are visible.",
    parameters: { type: "object", properties: { page: {}, grid: { type: "number" } }, required: ["page"] },
  },
  {
    name: "snapshotWithLayers",
    description: "Prepend a @layers header to the snapshot tree and attach a layers field so overlays are visible before the a11y tree.",
    parameters: { type: "object", properties: { page: {}, options: { type: "object" } }, required: ["page"] },
  },
  {
    name: "emulate",
    description: "Apply a DEVICE_PRESETS name, a custom metrics object, or null to restore the original UA captured on first call.",
    parameters: { type: "object", properties: { page: {}, preset: {} }, required: ["page", "preset"] },
  },
  {
    name: "createRoutes",
    description: "Install page request interception; Fetch.enable is sent only on the first route(); interception is fingerprintable, keep it off by default.",
    parameters: { type: "object", properties: { page: {} }, required: ["page"] },
  },
  {
    name: "route.continue",
    description: "Continue an intercepted request, optionally overriding url, method, headers, or postData.",
    parameters: { type: "object", properties: { url: { type: "string" }, method: { type: "string" }, headers: { type: "object" }, postData: {} } },
  },
  {
    name: "route.fulfill",
    description: "Fulfill an intercepted request with {status,headers,contentType,body} instead of hitting the network.",
    parameters: { type: "object", properties: { status: { type: "number" }, headers: { type: "object" }, contentType: { type: "string" }, body: {} } },
  },
  {
    name: "route.abort",
    description: "Abort an intercepted request with a CDP errorReason (defaults to Failed).",
    parameters: { type: "object", properties: { reason: { type: "string" } } },
  },
];
