#!/usr/bin/env node
// Counts the o200k_base tokens a model would read for a fixed list of public
// pages: the raw HTML, compactSnapshot(page.snapshot()) and the interactive-only
// snapshot. Prints one markdown table row per page. Live pages change, so the
// numbers drift between runs.
//
//   node scripts/bench-snapshot-tokens.mjs --browser <chromium> [--browser-arg=<arg> ...]
//   OMOWRIGHT_BENCH_BROWSER=<chromium> node scripts/bench-snapshot-tokens.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { compactSnapshot, connectPipe } from "../src/index.js";

const PAGES = [
  { url: "https://news.ycombinator.com/", shape: "link-heavy" },
  { url: "https://en.wikipedia.org/wiki/Web_browser", shape: "long article" },
  { url: "https://github.com/code-yeongyu/omowright", shape: "app-like" },
  { url: "https://example.com/", shape: "trivial" },
  { url: "https://httpbin.org/forms/post", shape: "form" },
];

const USAGE = `usage: node scripts/bench-snapshot-tokens.mjs --browser <chromium> [--browser-arg=<arg> ...]
  --browser       Chromium, Chrome or chrome-headless-shell binary (or set OMOWRIGHT_BENCH_BROWSER)
  --browser-arg   extra browser argument, repeatable; write it as --browser-arg=--no-sandbox`;

let values;
try {
  ({ values } = parseArgs({
    options: {
      browser: { type: "string" },
      "browser-arg": { type: "string", multiple: true, default: [] },
      help: { type: "boolean", short: "h" },
    },
  }));
} catch (error) {
  console.error(`${error.message}\n${USAGE}`);
  process.exit(2);
}
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
const browserPath = values.browser ?? process.env.OMOWRIGHT_BENCH_BROWSER;
if (!browserPath) {
  console.error(USAGE);
  process.exit(2);
}

// Each page gets its own browser and profile, so one page's cache, cookies or
// background work cannot change another page's numbers.
async function measure(url) {
  const profile = mkdtempSync(path.join(tmpdir(), "omowright-bench-"));
  let browser;
  try {
    browser = await connectPipe({
      browserPath,
      browserArgs: ["--headless", "--no-first-run", `--user-data-dir=${profile}`, ...values["browser-arg"]],
      storageRoot: profile,
    });
    const page = await browser.newTab();
    await page.goto(url);
    const html = await page.evaluate("document.documentElement.outerHTML");
    const snapshot = compactSnapshot(await page.snapshot());
    const interactive = compactSnapshot(await page.snapshot({ interactive: true }));
    return { html: countTokens(html), snapshot: countTokens(snapshot), interactive: countTokens(interactive) };
  } finally {
    await browser?.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

const count = n => n.toLocaleString("en-US");
const percent = (part, whole) => `${((100 * part) / whole).toFixed(1)}%`;

const rows = [];
let failures = 0;
for (const { url, shape } of PAGES) {
  const name = url.replace(/^https:\/\//, "").replace(/\/$/, "");
  try {
    const t = await measure(url);
    rows.push(`| ${name} | ${shape} | ${count(t.html)} | ${count(t.snapshot)} | ${count(t.interactive)} | ${percent(t.snapshot, t.html)} | ${percent(t.interactive, t.html)} |`);
  } catch (error) {
    failures++;
    console.error(`${url}: ${error?.message ?? error}`);
    rows.push(`| ${name} | ${shape} | failed | failed | failed | n/a | n/a |`);
  }
}

console.log("| Page | Shape | Raw HTML | Snapshot | Interactive snapshot | Snapshot / HTML | Interactive / HTML |");
console.log("| --- | --- | ---: | ---: | ---: | ---: | ---: |");
for (const row of rows) console.log(row);
if (failures) process.exitCode = 1;
