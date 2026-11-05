function injectHumanBanner(prompt) {
  if (document.querySelector('[data-omowright-human="1"]')) return true;
  const host = document.createElement("div");
  host.setAttribute("data-omowright-human", "1");
  host.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;display:block;visibility:visible;opacity:1;pointer-events:auto;";
  const root = host.attachShadow({ mode: "open" });
  const bar = document.createElement("div");
  bar.setAttribute("style", "display:flex;align-items:center;gap:12px;padding:10px 16px;background:#111;color:#fff;font:14px/1.4 system-ui,sans-serif;");
  const message = document.createElement("span");
  message.textContent = prompt == null ? "" : String(prompt);
  const button = document.createElement("button");
  button.textContent = "Done";
  button.addEventListener("click", () => {
    window.__omowrightHumanDone = true;
  });
  bar.append(message, button);
  root.append(bar);
  (document.documentElement ?? document.body).appendChild(host);
  return true;
}

function humanBannerPresent() {
  return document.querySelector('[data-omowright-human="1"]') !== null;
}

function humanDoneFlag() {
  return window.__omowrightHumanDone === true;
}

function querySelectorExists(selector) {
  return document.querySelector(selector) !== null;
}

function removeHumanBanner() {
  document.querySelectorAll('[data-omowright-human="1"]').forEach(node => node.remove());
  try {
    delete window.__omowrightHumanDone;
  } catch {
    window.__omowrightHumanDone = undefined;
  }
}

function sleep(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function ensureBanner(page, prompt) {
  try {
    if (await page.evaluate(humanBannerPresent)) return;
    await page.evaluate(injectHumanBanner, prompt ?? "");
  } catch {
    // Page may be mid-navigation; the next poll retries.
  }
}

async function matchesUntil(page, until) {
  if (until == null) return false;
  if (typeof until === "function") return Boolean(await until(page));
  if (typeof until === "object") {
    if (Object.prototype.hasOwnProperty.call(until, "url")) {
      const current = page.url();
      const expected = until.url;
      if (expected instanceof RegExp) return expected.test(current);
      return String(current).includes(String(expected));
    }
    if (typeof until.selector === "string") {
      try {
        return Boolean(await page.evaluate(querySelectorExists, until.selector));
      } catch {
        return false;
      }
    }
  }
  return false;
}

async function isDone(page) {
  try {
    return await page.evaluate(humanDoneFlag) === true;
  } catch {
    return false;
  }
}

export async function requestHuman(page, { prompt, until, timeoutMs = 300000, pollMs = 500, signal } = {}) {
  const started = Date.now();
  const finish = (outcome, reason) => ({ outcome, elapsedMs: Date.now() - started, reason });

  try {
    await page.bringToFront().catch(() => {});
    await ensureBanner(page, prompt);

    for (;;) {
      if (signal?.aborted) return finish("cancelled", "signal");
      // Check the conditions before the deadline: a slow bringToFront or banner
      // injection must not time the wait out before its first check.
      if (await matchesUntil(page, until)) return finish("continued", "until");
      if (await isDone(page)) return finish("continued", "done-button");
      if (Date.now() - started >= timeoutMs) return finish("timed_out", "timed_out");
      // Human waits are idle time, not a race against a specific event; a timer
      // poll loop is the correct tool here.
      await ensureBanner(page, prompt);
      const remaining = timeoutMs - (Date.now() - started);
      if (remaining <= 0) return finish("timed_out", "timed_out");
      await sleep(Math.min(pollMs, remaining), signal);
    }
  } finally {
    await page.evaluate(removeHumanBanner).catch(() => {});
  }
}
