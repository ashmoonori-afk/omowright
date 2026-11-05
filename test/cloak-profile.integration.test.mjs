import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  connectCloakProfile,
  findCloakBrowserPath,
} from "../src/index.js";
import { removeTreeSync } from "./fixtures/remove-tree.mjs";

async function withSmokeServer(run, handler) {
  const profileDir = mkdtempSync(path.join(tmpdir(), "omowright-cloak-e2e-"));
  const server = createServer(handler ?? ((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>profile smoke</title><main>ready</main>");
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run({ profileDir, url: `http://127.0.0.1:${server.address().port}/` });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    removeTreeSync(profileDir);
  }
}

let cloakBrowser;
try { cloakBrowser = findCloakBrowserPath(); } catch { cloakBrowser = undefined; }
const BROWSER = process.env.CLOAKBROWSER_BIN ?? cloakBrowser;

const probe = `(() => ({ webdriver: navigator.webdriver, value: localStorage.getItem("omowright-profile-smoke") }))()`;

// Real renderer ordering: an initial document can become busy between
// Page.enable and DOM.enable. Establish domains before starting that document,
// rather than relying on its load winning the attach race.
test("a reused cloak profile initializes domains before its first navigation", { skip: !BROWSER && !process.env.SHELL_BIN && "no Chromium binary found", timeout: 60000 }, async () => {
  const pageEnabled = Promise.withResolvers();
  const domainReady = Promise.withResolvers();
  const blocked = Promise.withResolvers();
  await withSmokeServer(async ({ profileDir, url }) => {
    const browserPath = BROWSER ?? process.env.SHELL_BIN;
    const first = await connectCloakProfile({ browserPath, profileDir, fingerprintSeed: 31415 });
    await first.close();
    let second;
    try {
      second = await connectCloakProfile({ browserPath, profileDir, commandTimeoutMs: 5000 });
      const send = second.cdp.send.bind(second.cdp);
      let earlyNavigation;
      second.cdp.send = async (method, params, sessionId, options) => {
        if (method === "Target.createTarget") earlyNavigation = params.url !== "about:blank";
        const result = await send(method, params, sessionId, options);
        if (method === "Page.enable") {
          pageEnabled.resolve();
          // Inject the loaded-host ordering: the document starts synchronous
          // work before the caller can send its next domain command.
          if (earlyNavigation) await blocked.promise;
        }
        if (method === "DOM.enable") domainReady.resolve();
        return result;
      };
      const page = await second.newTab(url);
      assert.equal(await page.evaluate("document.querySelector('main').textContent"), "ready");
    } finally {
      pageEnabled.resolve();
      domainReady.resolve();
      await second?.close();
    }
  }, (request, response) => {
    if (request.url === "/blocked") {
      blocked.resolve();
      domainReady.promise.then(() => response.end("ready"));
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.write("<!doctype html><main>ready</main>");
    pageEnabled.promise.then(() => response.end(`<script>
      const request = new XMLHttpRequest();
      request.open("GET", "/blocked", false);
      request.send();
    </script>`));
  });
});

// connectCloakProfile resolves CLOAKBROWSER_BIN first, so this contract runs on any Chromium (CI uses chrome-headless-shell).
test("a cloak profile reuses site state and its fingerprint seed across reloads", { skip: !BROWSER && "no Chromium binary found", timeout: 60000 }, async () => {
  await withSmokeServer(async ({ profileDir, url }) => {
    const first = await connectCloakProfile({ profileDir, fingerprintSeed: 31415 });
    const firstPage = await first.newTab(url);
    await firstPage.evaluate(`localStorage.setItem("omowright-profile-smoke", "persisted")`);
    await first.close();

    const second = await connectCloakProfile({ profileDir });
    const secondState = await (await second.newTab(url)).evaluate(probe);
    await second.close();

    const metadata = JSON.parse(readFileSync(path.join(profileDir, ".omowright-cloak.json"), "utf8"));
    assert.equal(secondState.value, "persisted");
    assert.equal(metadata.fingerprintSeed, 31415);
  });
});

// navigator.webdriver === false is CloakBrowser's own patch; a stock Chromium reports true, so this needs the real binary.
test("CloakBrowser hides navigator.webdriver on a reused profile", { skip: !cloakBrowser && "no CloakBrowser binary installed", timeout: 60000 }, async () => {
  await withSmokeServer(async ({ profileDir, url }) => {
    const first = await connectCloakProfile({ browserPath: cloakBrowser, profileDir, fingerprintSeed: 31415 });
    const firstState = await (await first.newTab(url)).evaluate(`(() => { localStorage.setItem("omowright-profile-smoke", "persisted"); return ${probe}; })()`);
    await first.close();

    const second = await connectCloakProfile({ browserPath: cloakBrowser, profileDir });
    const secondState = await (await second.newTab(url)).evaluate(probe);
    await second.close();

    assert.deepEqual(firstState, { webdriver: false, value: "persisted" });
    assert.deepEqual(secondState, { webdriver: false, value: "persisted" });
  });
});
