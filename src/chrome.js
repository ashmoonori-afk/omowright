import { mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { UnsupportedOperationError } from "./core.js";
import { createProfileApis, chromeTimeToMs } from "./chrome-profile.js";

const EXTENSION_BRIDGE_REQUIRED = "requires the extension bridge in standalone OmOWright";
// CDP has no window-focus state, and document.hasFocus() is no substitute: OmOWright
// enables focus emulation on every page it attaches to (other automation clients do
// too), so those pages report focus, background agent windows included (#122).
const WINDOW_FOCUS_UNKNOWN = "is unavailable in standalone OmOWright: CDP exposes no window focus state; " +
  "track chrome.windows.onFocusChanged through the extension bridge instead";
const DOWNLOAD_TIMEOUT_MS = 30_000;

function matchUrlPattern(url, pattern) {
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  return patterns.some(item => {
    if (!item.includes("*")) return url.startsWith(item);
    const regex = new RegExp(`^${item.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    return regex.test(url);
  });
}

export function createChromeApi(connection, options = {}) {
  const profile = createProfileApis(options.profilePath);
  const cdp = connection.cdp;

  async function pageTargets() {
    return (await connection.listTargets()).filter(target => target.type === "page");
  }

  async function toTab(target) {
    let windowId = 0;
    try {
      const win = await cdp.send("Browser.getWindowForTarget", { targetId: target.targetId ?? target.id });
      windowId = win.windowId;
    } catch {}
    return {
      id: target.targetId ?? target.id,
      url: target.url ?? "",
      title: target.title ?? "",
      windowId,
      active: false,
      pinned: false,
      audible: false,
      discarded: false,
      groupId: -1,
      index: -1,
    };
  }

  const tabs = {
    async query(queryInfo = {}) {
      let targets = await pageTargets();
      if (queryInfo.url) targets = targets.filter(t => matchUrlPattern(t.url ?? "", queryInfo.url));
      if (queryInfo.title) targets = targets.filter(t => (t.title ?? "").includes(queryInfo.title));
      const out = [];
      for (const target of targets) {
        const tab = await toTab(target);
        if (queryInfo.windowId != null && tab.windowId !== queryInfo.windowId) continue;
        out.push(tab);
      }
      return out;
    },
    async get(tabId) {
      const targets = await pageTargets();
      const target = targets.find(t => (t.targetId ?? t.id) === tabId);
      if (!target) throw new Error(`No tab with id: ${tabId}`);
      return toTab(target);
    },
  };

  async function collectWindows(queryOptions = {}) {
    const byWindow = new Map();
    for (const target of await pageTargets()) {
      const tab = await toTab(target);
      const list = byWindow.get(tab.windowId) ?? [];
      list.push(tab);
      byWindow.set(tab.windowId, list);
    }
    return [...byWindow.entries()].map(([windowId, windowTabs]) => {
      const win = {
        id: windowId,
        type: "normal",
        state: "normal",
        alwaysOnTop: false,
        incognito: false,
      };
      if (queryOptions.populate) win.tabs = windowTabs;
      return win;
    });
  }

  const windows = {
    async get(windowId, queryOptions = {}) {
      const all = await collectWindows(queryOptions);
      const win = all.find(item => item.id === windowId);
      if (!win) throw new Error(`No window with id: ${windowId}`);
      return win;
    },
    async getCurrent(queryOptions = {}) {
      const all = await collectWindows(queryOptions);
      if (all.length === 0) throw new Error("No browser window found");
      return all[0];
    },
    async getLastFocused() {
      throw new UnsupportedOperationError(`chrome.windows.getLastFocused ${WINDOW_FOCUS_UNKNOWN}`);
    },
    async getAll(queryOptions = {}) {
      return collectWindows(queryOptions);
    },
  };

  const downloads = {
    async search(query = {}) {
      return profile.withDb("History", db => {
        const rows = db.prepare(
          `SELECT d.id, d.target_path, d.start_time, d.received_bytes, d.total_bytes, d.state,
                  (SELECT url FROM downloads_url_chains c WHERE c.id = d.id AND c.chain_index = 0) AS url
           FROM downloads d ORDER BY d.start_time DESC LIMIT ?`,
        ).all(query.limit ?? 100);
        return rows
          .map(row => ({
            id: Number(row.id),
            url: row.url ?? "",
            filename: row.target_path,
            startTime: row.start_time ? new Date(chromeTimeToMs(row.start_time)).toISOString() : null,
            bytesReceived: Number(row.received_bytes),
            totalBytes: Number(row.total_bytes),
            state: Number(row.state) === 1 ? "complete" : Number(row.state) === 2 ? "canceled" : Number(row.state) === 3 ? "interrupted" : "in_progress",
          }))
          .filter(item => !query.url || item.url.includes(query.url))
          .filter(item => !query.filename || item.filename.includes(query.filename));
      });
    },

    async download(downloadOptions) {
      const downloadDir = options.downloadDir ?? path.join(tmpdir(), "omowright-downloads");
      mkdirSync(downloadDir, { recursive: true });

      let resolveBegin;
      let resolveDone;
      let rejectDone;
      const began = new Promise(resolve => { resolveBegin = resolve; });
      const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
      const offBegin = cdp.on("Browser.downloadWillBegin", params => resolveBegin(params));
      const offProgress = cdp.on("Browser.downloadProgress", params => {
        if (params.state === "completed") resolveDone(params);
        else if (params.state === "canceled") rejectDone(new Error("Download was canceled"));
      });
      const timer = setTimeout(() => rejectDone(new Error(`chrome.downloads.download timed out after ${DOWNLOAD_TIMEOUT_MS}ms`)), DOWNLOAD_TIMEOUT_MS);

      const page = await connection.newTab("about:blank");
      try {
        await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir, eventsEnabled: true });
        await page.evaluate(`(() => {
          const a = document.createElement("a");
          a.href = ${JSON.stringify(downloadOptions.url)};
          document.body.appendChild(a);
          a.click();
        })()`);
        const begin = await Promise.race([began, done.then(() => null)]);
        if (!begin) throw new Error("No download started for the given URL");
        await done;
        const filename = downloadOptions.filename ?? begin.suggestedFilename;
        return {
          id: begin.guid,
          url: begin.url ?? downloadOptions.url,
          filename: path.join(downloadDir, filename ?? "download"),
          state: "complete",
        };
      } finally {
        clearTimeout(timer);
        offBegin();
        offProgress();
        await page.close().catch(() => {});
      }
    },

    async pause() { throw new UnsupportedOperationError(`chrome.downloads.pause ${EXTENSION_BRIDGE_REQUIRED}`); },
    async resume() { throw new UnsupportedOperationError(`chrome.downloads.resume ${EXTENSION_BRIDGE_REQUIRED}`); },
    async cancel() { throw new UnsupportedOperationError(`chrome.downloads.cancel ${EXTENSION_BRIDGE_REQUIRED}`); },
    async erase() { throw new UnsupportedOperationError(`chrome.downloads.erase ${EXTENSION_BRIDGE_REQUIRED}`); },
  };

  return {
    tabs,
    windows,
    downloads,
    bookmarks: profile.bookmarks,
    history: profile.history,
    topSites: profile.topSites,
  };
}
