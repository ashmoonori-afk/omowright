import { test } from "node:test";
import assert from "node:assert/strict";
import * as api from "../src/index.js";

const FUNCTION_EXPORTS = [
  "createNetworkSnoop",
  "collectWhileScrolling",
  "createTrace",
  "toHar",
  "reconcileFrames",
  "snapshotWithFrames",
  "normalizeDialogPolicy",
  "resolveDialogAction",
  "requestHuman",
  "describeLayers",
  "layersHeader",
  "snapshotWithLayers",
  "emulate",
  "createRoutes",
  "connectBrowserSkill",
  "listBrowsers",
  "bskSnapshot",
  "buildSnapshotExpression",
  "detectBrowsers",
  "externalExtensionEntry",
  "registerExternalExtension",
  "unregisterExternalExtension",
  "catalogBrowsers",
  "probeBrowserSignals",
  "identifyBrowser",
  "installBskCli",
  "bskDoctor",
  "bskOnboard",
  "readDaemonInfo",
  "resolveBskHome",
];

const CLASS_EXPORTS = ["BskIpcClient", "BskRpcError", "BskSession", "SharedConnectionError"];

test("package entrypoint exports the new public surfaces", () => {
  for (const name of FUNCTION_EXPORTS) {
    assert.equal(typeof api[name], "function", name);
  }
  assert.equal(typeof api.DEVICE_PRESETS, "object");
  assert.ok(api.DEVICE_PRESETS && !Array.isArray(api.DEVICE_PRESETS));
  for (const name of CLASS_EXPORTS) {
    assert.equal(typeof api[name], "function", name);
    assert.ok(api[name].prototype, `${name} is a class`);
  }
  assert.equal(api.BROWSERSKILL_EXTENSION_IDS.chrome, "hhcmgoofomhgciiibhipgmgkgnoenaoi");
  assert.equal(typeof api.STORE_PAGE_URLS.edge, "string");
});
