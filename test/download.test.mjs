import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { connectPipe, OmOPage } from "../src/index.js";

// Public API contract: a real download can be copied with saveAs, including
// creating a destination directory. Event tests never exercise the file copy.
test("download.saveAs copies a real download into a new directory", {
  skip: !process.env.SHELL_BIN && "SHELL_BIN is required",
  timeout: 60000,
}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "omowright-save-as-"));
  let browser, page, off;
  t.after(async () => {
    await page?.dispose();
    off?.();
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const payload = "download payload\n";
  const server = createServer((request, response) => {
    if (request.url === "/file") {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="payload.txt"',
      });
      response.end(payload);
    } else {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<!doctype html><title>Download</title><a href="/file">Download file</a><p>A local download fixture with enough visible content for readiness.</p>');
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await connectPipe({
    browserPath: process.env.SHELL_BIN,
    browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${path.join(root, "profile")}`],
    storageRoot: root,
  });
  const attached = await browser.newTab(`http://127.0.0.1:${server.address().port}/`);
  // OmOPage's download contract uses the daemon to resolve a completed file.
  // Supply that host contract from real CDP completion events: no fake file,
  // download object, or filesystem operation substitutes for saveAs.
  let finish;
  const completed = new Promise(resolve => { finish = resolve; });
  off = browser.cdp.on("Browser.downloadProgress", info => {
    if (info.state === "completed") finish({ absolutePath: info.filePath, downloadId: info.guid });
  });
  await browser.cdp.send("Browser.setDownloadBehavior", {
    behavior: "allow", downloadPath: path.join(root, "downloads"), eventsEnabled: true,
  });
  const cdp = {
    on: (...args) => browser.cdp.on(...args),
    send: (method, ...args) => method === "OmO.waitForDownload" ? completed : browser.cdp.send(method, ...args),
  };
  page = new OmOPage(cdp, attached.frameManager, attached.targetId, await attached.resolveSessionId(),
    { ...attached.browser, registerReadableDownloadPath: value => value });
  const pending = page.waitForEvent("download", { timeout: 10000 });
  await page.locator("a").click();
  const download = await pending;
  assert.equal(download.suggestedFilename(), "payload.txt");
  const destination = path.join(root, "saved", "nested", "copy.txt");
  await download.saveAs(destination);
  assert.equal(await readFile(destination, "utf8"), payload);
});
