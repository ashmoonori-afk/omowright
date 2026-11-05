import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync, mkdirSync, symlinkSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createNativeMessagingHost, encodeFrame, decodeFrames, installNativeMessagingHost, ExtensionHelloSchema, EventSchema, ResponseSchema, createChromeApi, BridgeProtocolError } from "../src/index.js";
import { COMMAND_NAMES, EVENT_NAMES } from "../src/bridge-transport.js";
import { installWin32NativeHost, isWin32RegistryKey, win32DirectoryChain, win32PathRisk } from "../src/native-host-win32.js";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const extensionId = "a".repeat(32);
const hello = { protocol: 1, type: "hello", role: "extension", connectionId: "c1", extensionId, extensionVersion: "0.1.0", events: ["tabs.activated"], commands: ["bookmarks.create"], maxMessageBytes: 1024 * 1024 };
// Platform contract: registration runs for real on every OS. On Windows the host is a .cmd file, the browser reads the
// manifest path from an HKCU registry value (a per-test key, deleted afterwards), and "writable by others" is an ACL grant.
const win32 = process.platform === "win32";
const registrationTimeout = { timeout: 60_000 };
function hostExecutable(dir, name = "host") { const file = path.join(dir, win32 ? `${name}.cmd` : name); writeFileSync(file, win32 ? "@echo off\r\n" : "#!/bin/sh\n", { mode: 0o755 }); return file; }
function testRegistry() { if (!win32) return { options: {}, cleanup() {} }; const root = `HKCU\\Software\\omowright-test-${randomUUID()}`; return { options: { registryKey: `${root}\\NativeMessagingHosts` }, cleanup() { spawnSync("reg.exe", ["delete", root, "/f"], { windowsHide: true }); } }; }
function registryDefault(key) { const out = spawnSync("reg.exe", ["query", key, "/ve"], { encoding: "utf8", windowsHide: true }); return /REG_SZ\s+(.+?)\s*$/m.exec(out.stdout ?? "")?.[1] ?? null; }
function grantsSid(file, sid) { return spawnSync("icacls", [file, "/findsid", `*${sid}`], { encoding: "utf8", windowsHide: true }).stdout.includes("SID Found"); }
function setEveryoneModify(dir, on, rights = "(OI)(CI)M") { const out = spawnSync("icacls", on ? [dir, "/grant", `*S-1-1-0:${rights}`] : [dir, "/remove:g", "*S-1-1-0"], { encoding: "utf8", windowsHide: true }); assert.equal(out.status, 0, out.stdout + out.stderr); }
function streams() { return { input: new PassThrough(), output: new PassThrough(), error: new PassThrough() }; }
function readOne(stream) { return new Promise((resolve, reject) => { const chunks = []; const onData = chunk => { chunks.push(chunk); const parsed = decodeFrames(Buffer.concat(chunks)); if (parsed.frames.length) { stream.off("data", onData); resolve(parsed.frames[0]); } }; stream.on("data", onData); stream.once("error", reject); }); }

test("native frames support splits and multiple messages with exact binary contract", () => {
  const frame = encodeFrame({ ok: true });
  assert.equal(frame.readUInt32LE(0), frame.length - 4);
  assert.equal(frame.at(-1), 0x7d);
  assert.equal(frame.includes(0x0a), false);
  for (let i = 0; i <= frame.length; i++) { const first = decodeFrames(frame.subarray(0, i)); const second = decodeFrames(Buffer.concat([first.remainder, frame.subarray(i)])); assert.deepEqual([...first.frames, ...second.frames], [{ ok: true }]); }
  assert.deepEqual(decodeFrames(Buffer.concat([frame, frame])).frames, [{ ok: true }, { ok: true }]);
});

test("native frame parser rejects malformed and oversized messages", () => {
  assert.throws(() => decodeFrames(Buffer.from([0, 0, 0, 0])), BridgeProtocolError);
  assert.throws(() => decodeFrames(Buffer.from([1, 0, 0, 0, 0xff])), BridgeProtocolError);
  assert.throws(() => encodeFrame({ x: "x" }, 1), BridgeProtocolError);
});

test("strict schemas reject unknown names and fields", () => {
  assert.equal(ExtensionHelloSchema.safeParse(hello).success, true);
  assert.equal(ExtensionHelloSchema.safeParse({ ...hello, extra: true }).success, false);
  assert.equal(EventSchema.safeParse({ protocol: 1, type: "event", connectionId: "c1", seq: 1, occurredAt: 1, name: "tabs.activated", payload: { tabId: 2, windowId: 1, extra: true } }).success, false);
});

test("host validates hello, negotiates capabilities, correlates response, and forwards events", async () => {
  const s = streams(); const events = [];
  const host = createNativeMessagingHost({ stdin: s.input, stdout: s.output, stderr: s.error, extensionId, onEvent: event => events.push(event) });
  s.input.write(encodeFrame(hello));
  const hostHello = await readOne(s.output);
  assert.equal(hostHello.protocol, 1); assert.equal(hostHello.type, "hello"); assert.equal(hostHello.role, "host"); assert.equal(typeof hostHello.connectionId, "string"); assert.equal(hostHello.hostName, "com.omowright.cloakbridge"); assert.deepEqual(hostHello.commands, ["bookmarks.create"]);
  const request = host.request("bookmarks.create", { details: { title: "x" } });
  const sent = await readOne(s.output);
  assert.equal(sent.name, "bookmarks.create");
  s.input.write(encodeFrame({ protocol: 1, type: "response", requestId: sent.requestId, name: sent.name, ok: true, result: { id: "1", title: "x" } }));
  assert.deepEqual(await request, { id: "1", title: "x" });
  s.input.write(encodeFrame({ protocol: 1, type: "event", connectionId: "c1", seq: 1, occurredAt: 1, name: "tabs.activated", payload: { tabId: 4, windowId: 1 } }));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(events[0].payload.tabId, 4); host.close();
});

test("registration writes pinned manifest atomically and rejects unverified CloakBrowser path", registrationTimeout, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-reg-")); const executable = hostExecutable(root); const dir = path.join(root, "hosts"); const registry = testRegistry();
  try {
    const result = await installNativeMessagingHost({ hostPath: executable, extensionId, nativeMessagingHostDir: dir, ...registry.options });
    assert.deepEqual(JSON.parse(readFileSync(result.path)), result.manifest); assert.equal(result.manifest.allowed_origins[0], `chrome-extension://${extensionId}/`);
    if (win32) {
      assert.equal(result.registryKey, `${registry.options.registryKey}\\com.omowright.cloakbridge`); assert.equal(registryDefault(result.registryKey), result.path);
      for (const sid of ["S-1-1-0", "S-1-5-32-545", "S-1-5-11"]) assert.equal(grantsSid(result.path, sid), false, `manifest ACL grants ${sid}`);
    } else assert.equal(statSync(result.path).mode & 0o777, 0o600);
    await assert.rejects(() => installNativeMessagingHost({ hostPath: executable, extensionId, browser: "cloakbrowser" }), /explicit and verified/);
  } finally { registry.cleanup(); rmSync(root, { recursive: true, force: true }); }
});

test("chrome API routes negotiated writes and preserves unsupported fallback", async () => {
  const calls = []; const bridge = { isConnected: true, capabilities: { commands: new Set(["bookmarks.create"]), events: new Set() }, request: async (...args) => { calls.push(args); return { id: "2", title: "x" }; } };
  const chrome = createChromeApi({}, { bridge }); assert.deepEqual(await chrome.bookmarks.create({ title: "x" }), { id: "2", title: "x" }); assert.deepEqual(calls[0], ["bookmarks.create", { details: { title: "x" }}]); await assert.rejects(() => chrome.history.deleteUrl({ url: "https://x.test/" }), /requires the extension bridge/);
});

test("decoder accepts literal replacement characters but rejects malformed UTF-8", () => {
  const frame = encodeFrame({ text: "literal \\ufffd" }); assert.deepEqual(decodeFrames(frame).frames, [{ text: "literal \\ufffd" }]);
  assert.throws(() => decodeFrames(Buffer.from([1, 0, 0, 0, 0xc3])), /invalid UTF-8/);
});

test("mutations wait for the prior response and duplicate event sequences disconnect", async () => {
  const s = streams(); const host = createNativeMessagingHost({ stdin: s.input, stdout: s.output, stderr: s.error, extensionId }); s.input.write(encodeFrame(hello)); await readOne(s.output);
  const first = host.request("bookmarks.create", { details: { title: "one" } }); const sent1 = await readOne(s.output); const second = host.request("bookmarks.create", { details: { title: "two" } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(s.output.readableLength, 0);
  s.input.write(encodeFrame({ protocol: 1, type: "response", requestId: sent1.requestId, name: sent1.name, ok: true, result: { id: "1", title: "one" } })); await first; const sent2 = await readOne(s.output); assert.equal(sent2.params.details.title, "two"); s.input.write(encodeFrame({ protocol: 1, type: "response", requestId: sent2.requestId, name: sent2.name, ok: true, result: { id: "2", title: "two" } })); await second;
  const event = { protocol: 1, type: "event", connectionId: "c1", seq: 1, occurredAt: 1, name: "tabs.activated", payload: { tabId: 1, windowId: 1 } }; s.input.write(encodeFrame(event)); await new Promise(resolve => setImmediate(resolve)); s.input.write(encodeFrame({ ...event, seq: 1 })); await new Promise(resolve => setImmediate(resolve)); assert.equal(host.isConnected, false); await second.catch(() => {}); host.close();
});

test("registration rejects endpointPath, unsafe host names, and overwrites only with force", registrationTimeout, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-reg-hardening-")); const executable = hostExecutable(root); const dir = path.join(root, "hosts"); const registry = testRegistry(); const options = { hostPath: executable, extensionId, nativeMessagingHostDir: dir, ...registry.options };
  try {
    await assert.rejects(() => installNativeMessagingHost({ ...options, endpointPath: "/tmp/x" }), /endpointPath/); await assert.rejects(() => installNativeMessagingHost({ ...options, hostName: "../evil" }), /hostName/);
    await installNativeMessagingHost(options); await assert.rejects(() => installNativeMessagingHost(options), /already exists/); await installNativeMessagingHost({ ...options, force: true });
    if (win32) {
      // the per-user registry value is only repointed at another manifest with force
      const other = { ...options, nativeMessagingHostDir: path.join(root, "other", "hosts") };
      await assert.rejects(() => installNativeMessagingHost(other), /already points at/);
      // the refusal comes after this call created other\hosts, and it removes both directories it made
      assert.equal(existsSync(path.join(root, "other")), false);
      const moved = await installNativeMessagingHost({ ...other, force: true }); assert.equal(registryDefault(moved.registryKey), moved.path);
    }
  } finally { registry.cleanup(); rmSync(root, { recursive: true, force: true }); }
});

// Platform contract: a failing install removes only what it created. Call A creates the new directory; a second install
// into it registers before A writes, so A fails like the shared writer does and must leave the other's manifest alone.
test("a failed win32 install never removes a concurrent install's manifest", { ...registrationTimeout, skip: !win32 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-reg-race-")); const executable = hostExecutable(root); const dir = path.join(root, "new", "hosts"); const registry = testRegistry();
  const options = { hostPath: executable, extensionId, nativeMessagingHostDir: dir, ...registry.options };
  try {
    let winner;
    const writeManifest = async file => { winner = await installNativeMessagingHost(options); if (existsSync(file)) throw new Error("registration manifest already exists; use force"); };
    await assert.rejects(() => installWin32NativeHost({ hostName: "com.omowright.cloakbridge", hostPath: executable, dir, registryKey: registry.options.registryKey, force: false, writeManifest }), /already exists/);
    assert.equal(registryDefault(winner.registryKey), winner.path); assert.equal(existsSync(winner.path), true, "the winner's registered manifest was removed");
  } finally { registry.cleanup(); rmSync(root, { recursive: true, force: true }); }
});

test("timed out mutation fails the connection without sending its successor", async () => {
  const s = streams(); const host = createNativeMessagingHost({ stdin: s.input, stdout: s.output, stderr: s.error, extensionId, commandTimeoutMs: 10 }); s.input.write(encodeFrame(hello)); await readOne(s.output);
  const first = host.request("bookmarks.create", { details: { title: "one" } }); await readOne(s.output); const second = host.request("bookmarks.create", { details: { title: "two" } });
  await assert.rejects(first, error => error.code === "TIMEOUT"); await assert.rejects(second, /indeterminate/); assert.equal(host.isConnected, false); assert.equal(s.output.readableLength, 0);
});

test("command queue is bounded independently of the write queue", async () => {
  const s = streams(); const host = createNativeMessagingHost({ stdin: s.input, stdout: s.output, stderr: s.error, extensionId, maxPendingWrites: 2 }); s.input.write(encodeFrame(hello)); await readOne(s.output);
  const first = host.request("bookmarks.create", { details: { title: "one" } }); const sent = await readOne(s.output); const second = host.request("bookmarks.create", { details: { title: "two" } }); await assert.rejects(host.request("bookmarks.create", { details: { title: "three" } }), /BOUNDED_TRANSPORT/);
  s.input.write(encodeFrame({ protocol: 1, type: "response", requestId: sent.requestId, name: sent.name, ok: true, result: { id: "1", title: "one" } })); await first; const sent2 = await readOne(s.output); s.input.write(encodeFrame({ protocol: 1, type: "response", requestId: sent2.requestId, name: sent2.name, ok: true, result: { id: "2", title: "two" } })); await second; host.close();
});

test("public send rejects unknown envelopes and bookmark results reject unknown fields", async () => {
  const s = streams(); const host = createNativeMessagingHost({ stdin: s.input, stdout: s.output, stderr: s.error, extensionId }); s.input.write(encodeFrame(hello)); await readOne(s.output); await assert.rejects(host.send({ type: "bogus" }), /invalid outbound message type/);
  const request = host.request("bookmarks.create", { details: { title: "x" } }); const sent = await readOne(s.output); const result = { id: "1", title: "x", dateLastUsed: 1, folderType: "bookmarks-bar", syncing: true, futureChromeField: "rejected" }; assert.throws(() => encodeFrame({ protocol: 1, type: "response", requestId: sent.requestId, name: sent.name, ok: true, result }), /invalid outbound message/); host.close(); await assert.rejects(request, /closed/);
});

test("async onEvent rejection is reported without disconnecting", async () => {
  const s = streams(); const host = createNativeMessagingHost({ stdin: s.input, stdout: s.output, stderr: s.error, extensionId, onEvent: async () => { throw new Error("async boom"); } }); s.input.write(encodeFrame(hello)); await readOne(s.output); s.input.write(encodeFrame({ protocol: 1, type: "event", connectionId: "c1", seq: 1, occurredAt: 1, name: "tabs.activated", payload: { tabId: 1, windowId: 1 } })); await new Promise(resolve => setImmediate(resolve)); assert.match(s.error.read().toString(), /async boom/); assert.equal(host.isConnected, true); host.close();
});

test("abort after a received mutation response does not disconnect the bridge", async () => {
  const s = streams(); const controller = new AbortController(); const host = createNativeMessagingHost({ stdin: s.input, stdout: s.output, stderr: s.error, extensionId }); s.input.write(encodeFrame(hello)); await readOne(s.output);
  const request = host.request("bookmarks.create", { details: { title: "done" } }, { signal: controller.signal }); const sent = await readOne(s.output);
  s.input.write(encodeFrame({ protocol: 1, type: "response", requestId: sent.requestId, name: sent.name, ok: true, result: { id: "1", title: "done" } })); assert.deepEqual(await request, { id: "1", title: "done" }); controller.abort();
  assert.deepEqual(await request, { id: "1", title: "done" }); assert.equal(host.isConnected, true); host.close();
});

test("bookmark result schema is recursive and explicitly strict", () => {
  const response = { protocol: 1, type: "response", requestId: "abcdef0123456789", name: "bookmarks.create", ok: true, result: { id: "1", parentId: "0", index: 0, title: "folder", dateAdded: 1, dateGroupModified: 2, dateLastUsed: 3, folderType: "bookmarks-bar", syncing: false, unmodifiable: "managed", children: [{ id: "2", title: "link", url: "https://example.test/" }] } };
  assert.equal(ResponseSchema.safeParse(response).success, true); assert.equal(ResponseSchema.safeParse({ ...response, result: { ...response.result, futureChromeField: true } }).success, false); assert.equal(ResponseSchema.safeParse({ ...response, result: { ...response.result, children: [{ ...response.result.children[0], futureChromeField: true }] } }).success, false);
});

test("registration rejects writable or symlinked directory components", registrationTimeout, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-reg-components-")); const executable = hostExecutable(root); const parent = path.join(root, "parent"); const dir = path.join(parent, "hosts"); mkdirSync(parent); const registry = testRegistry();
  try {
    if (win32) setEveryoneModify(parent, true); else chmodSync(parent, 0o777);
    await assert.rejects(() => installNativeMessagingHost({ hostPath: executable, extensionId, nativeMessagingHostDir: dir, ...registry.options }), /security rejected/);
    if (win32) setEveryoneModify(parent, false); else chmodSync(parent, 0o700);
    const linked = path.join(root, "linked"); symlinkSync(parent, linked, win32 ? "junction" : undefined);
    await assert.rejects(() => installNativeMessagingHost({ hostPath: executable, extensionId, nativeMessagingHostDir: path.join(linked, "hosts"), ...registry.options }), /security rejected/);
    if (win32) {
      // Chrome starts the host in its own directory, so a directory others can add files to (DLLs, scripts) is refused;
      // the grant is AddFile/AddSubdirectory on the directory only, so the host file itself stays user-only
      const shared = path.join(root, "shared-bin"); mkdirSync(shared); const planted = hostExecutable(shared); setEveryoneModify(shared, true, "(WD,AD)");
      await assert.rejects(() => installNativeMessagingHost({ hostPath: planted, extensionId, nativeMessagingHostDir: path.join(root, "hosts"), ...registry.options }), /hostPath directory security rejected/);
      setEveryoneModify(shared, false);
    }
  } finally { registry.cleanup(); rmSync(root, { recursive: true, force: true }); }
});

test("settled mutations remove abort listeners and timers", async () => {
  const s = streams(); const controller = new AbortController(); const originalAdd = controller.signal.addEventListener.bind(controller.signal); const originalRemove = controller.signal.removeEventListener.bind(controller.signal); let added = 0; let removed = 0;
  controller.signal.addEventListener = (...args) => { added += 1; return originalAdd(...args); }; controller.signal.removeEventListener = (...args) => { removed += 1; return originalRemove(...args); };
  const host = createNativeMessagingHost({ stdin: s.input, stdout: s.output, stderr: s.error, extensionId, commandTimeoutMs: 60_000 }); s.input.write(encodeFrame(hello)); await readOne(s.output);
  const request = host.request("bookmarks.create", { details: { title: "done" } }, { signal: controller.signal }); const sent = await readOne(s.output);
  assert.equal(added, 1); s.input.write(encodeFrame({ protocol: 1, type: "response", requestId: sent.requestId, name: sent.name, ok: true, result: { id: "1", title: "done" } })); await request;
  assert.equal(removed, 1); controller.abort(); assert.equal(host.isConnected, true); host.close();
});

function loadExtension() {
  const ports = []; const timers = [];
  const listenerSlot = () => { const listeners = []; return { listeners, addListener: fn => listeners.push(fn) }; };
  const apiEvents = new Proxy({}, { get: (target, name) => (target[name] ??= listenerSlot()) });
  const chrome = {
    runtime: { id: extensionId, lastError: undefined, getManifest: () => ({ version: "0.1.0" }), connectNative: () => { const port = { posted: [], onMessage: listenerSlot(), onDisconnect: listenerSlot(), postMessage(message) { this.posted.push(message); } }; ports.push(port); return port; } },
    notifications: apiEvents, tabGroups: apiEvents, tabs: apiEvents, windows: apiEvents, bookmarks: {}, history: {}, debugger: {},
  };
  const context = vm.createContext({ chrome, crypto: globalThis.crypto, TextEncoder, URL, console: { warn() {} }, setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, clearTimeout() {} });
  vm.runInContext(readFileSync(new URL("../bridge/extension/background.js", import.meta.url), "utf8"), context);
  return { ports, timers };
}

test("extension protocol errors use a dedicated response name and reconnect indefinitely", async () => {
  const { ports, timers } = loadExtension();
  // the hello advertises exactly the host's command and event lists
  assert.deepEqual([...ports[0].posted[0].commands], [...COMMAND_NAMES]); assert.deepEqual([...ports[0].posted[0].events], [...EVENT_NAMES]);
  // an unknown command is answered under the dedicated protocolError name, never a real command name
  await ports[0].onMessage.listeners[0]({ protocol: 1, type: "command", requestId: "abcdef0123456789", name: "bogus.command", params: { details: {} } });
  const reply = JSON.parse(JSON.stringify(ports[0].posted.at(-1)));
  assert.equal(reply.name, "protocolError"); assert.equal(reply.ok, false); assert.equal(ResponseSchema.safeParse(reply).success, true);
  // disconnects keep reconnecting past the sixth attempt, at a capped backoff
  for (let attempt = 0; attempt < 8; attempt += 1) { ports.at(-1).onDisconnect.listeners[0](); timers.at(-1).fn(); }
  assert.equal(ports.length, 9);
  assert.deepEqual(timers.map(timer => timer.delay), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test("protocolError responses are schema-valid and cannot collide with commands", () => {
  const response = { protocol: 1, type: "response", requestId: "abcdef0123456789", name: "protocolError", ok: false, error: { code: "UNKNOWN_COMMAND", message: "invalid command" } };
  assert.equal(ResponseSchema.safeParse(response).success, true); assert.equal(ResponseSchema.safeParse({ ...response, ok: true, error: undefined, result: {} }).success, false); assert.equal(COMMAND_NAMES.includes("protocolError"), false);
});

test("registration rejects symlinked executables and parent components", registrationTimeout, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-reg-links-")); const real = path.join(root, "real"); mkdirSync(real); const executable = hostExecutable(real); const registry = testRegistry();
  try {
    const linkedHost = path.join(root, win32 ? "linked-host.cmd" : "linked-host"); symlinkSync(executable, linkedHost, win32 ? "file" : undefined);
    await assert.rejects(() => installNativeMessagingHost({ hostPath: linkedHost, extensionId, nativeMessagingHostDir: path.join(root, "hosts"), ...registry.options }), /owned executable/);
    const linkedParent = path.join(root, "linked-parent"); symlinkSync(real, linkedParent, win32 ? "junction" : undefined);
    await assert.rejects(() => installNativeMessagingHost({ hostPath: executable, extensionId, nativeMessagingHostDir: path.join(linkedParent, "hosts"), ...registry.options }), /security rejected/);
  } finally { registry.cleanup(); rmSync(root, { recursive: true, force: true }); }
});

test("write rejection removes the abort listener", async () => {
  const s = streams();
  const controller = new AbortController();
  const originalAdd = controller.signal.addEventListener.bind(controller.signal);
  const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
  let added = 0; let removed = 0;
  controller.signal.addEventListener = (...args) => { added += 1; return originalAdd(...args); };
  controller.signal.removeEventListener = (...args) => { removed += 1; return originalRemove(...args); };
  const hangingOutput = new PassThrough();
  hangingOutput.write = () => true; // write never completes: the host hello occupies the single write slot
  const host = createNativeMessagingHost({ stdin: s.input, stdout: hangingOutput, stderr: s.error, extensionId, maxPendingWrites: 1, commandTimeoutMs: 60_000 });
  s.input.write(encodeFrame(hello));
  await new Promise(resolve => setImmediate(resolve));
  const result = await host.request("bookmarks.create", { details: { title: "x", url: "https://example.com/" } }, { signal: controller.signal }).catch(error => error);
  assert.ok(result instanceof Error);
  assert.equal(result.message, "BOUNDED_TRANSPORT");
  assert.equal(added, 1);
  assert.equal(removed, 1);
});

test("request with an already-aborted signal rejects instead of hanging", async () => {
  const s = streams();
  const host = createNativeMessagingHost({ stdin: s.input, stdout: s.output, stderr: s.error, extensionId, commandTimeoutMs: 60_000 });
  s.input.write(encodeFrame(hello));
  await readOne(s.output);
  const controller = new AbortController();
  controller.abort();
  const settled = await Promise.race([
    host.request("bookmarks.create", { details: { title: "x", url: "https://example.com/" } }, { signal: controller.signal }).then(() => "resolved", error => `rejected:${error.message}`),
    new Promise(resolve => setTimeout(() => resolve("never-settled"), 500)),
  ]);
  assert.notEqual(settled, "never-settled");
  assert.match(settled, /^rejected:/);
  host.close();
});

// Security contract: the Windows ACL policy that decides whether a native-messaging host may be registered. The real
// registration (PowerShell + reg.exe) is exercised on Windows by test/bridge-transport.test.mjs; this table pins the
// policy on every OS so a loosened rights mask or trusted-SID set fails anywhere.
const USER = "S-1-5-21-1-2-3-1001";
const EVERYONE = "S-1-1-0";
const USERS = "S-1-5-32-545";
const AUTHENTICATED = "S-1-5-11";
const FULL = 0x1f01ff;
const MODIFY = 0x1301bf;
const READ_EXECUTE = 0x1200a9;
const ace = (sid, rights, extra = {}) => ({ sid, rights, allow: true, inheritOnly: false, ...extra });
const base = [ace(USER, FULL), ace("S-1-5-18", FULL), ace("S-1-5-32-544", FULL)];
const dir = (aces = [], extra = {}) => ({ path: "C:\\x", exists: true, directory: true, reparse: false, owner: USER, aces: [...base, ...aces], ...extra });
const exe = (aces = [], extra = {}) => ({ ...dir(aces, extra), path: "C:\\x\\host.cmd", directory: false, ...extra });

test("win32PathRisk accepts only paths no untrusted principal can change, per component kind", () => {
  const cases = [
    ["user-only final dir", dir(), "final", null],
    ["final dir owned by Administrators", dir([], { owner: "S-1-5-32-544" }), "final", null],
    ["final dir owned by another user", dir([], { owner: "S-1-5-21-9-9-9-500" }), "final", /owned by untrusted/],
    ["Everyone Modify on final dir", dir([ace(EVERYONE, MODIFY)]), "final", /grants S-1-1-0/],
    ["inherit-only Everyone Modify on final dir", dir([ace(EVERYONE, MODIFY, { inheritOnly: true })]), "final", null],
    ["deny Everyone Full on final dir", dir([ace(EVERYONE, FULL, { allow: false })]), "final", null],
    ["Users read on final dir", dir([ace(USERS, READ_EXECUTE)]), "final", null],
    ["Users AddSubdirectory on final dir", dir([ace(USERS, 0x4)]), "final", /grants S-1-5-32-545/],
    ["Users AddFile on the host's own dir (DLL planting)", dir([ace(USERS, 0x2)]), "final", /grants S-1-5-32-545/],
    ["(OI)(IO) Users Modify on final dir reaches every new file", dir([ace(USERS, MODIFY, { inheritOnly: true, objectInherit: true })]), "final", /grants S-1-5-32-545/],
    ["(OI)(IO) CREATOR OWNER Full on final dir", dir([ace("S-1-3-0", FULL, { inheritOnly: true, objectInherit: true })]), "final", null],
    ["(OI)(IO) Users Modify on ancestor", dir([ace(USERS, MODIFY, { inheritOnly: true, objectInherit: true })]), "ancestor", null],
    ["unreadable component", { path: "C:\\x", exists: false, inaccessible: true }, "ancestor", /could not be inspected/],
    ["Users AddSubdirectory on ancestor (default C:\\)", dir([ace(USERS, 0x4), ace(AUTHENTICATED, 0x4)]), "ancestor", null],
    ["Users AddFile on ancestor", dir([ace(USERS, 0x2)]), "ancestor", null],
    ["Users DeleteChild on ancestor", dir([ace(USERS, 0x40)]), "ancestor", /grants S-1-5-32-545/],
    ["Authenticated Users Modify on ancestor", dir([ace(AUTHENTICATED, MODIFY)]), "ancestor", /grants S-1-5-11/],
    ["Everyone WRITE_DAC on ancestor", dir([ace(EVERYONE, 0x40000)]), "ancestor", /grants S-1-1-0/],
    ["Everyone GENERIC_ALL on ancestor", dir([ace(EVERYONE, 0x10000000)]), "ancestor", /grants S-1-1-0/],
    ["OWNER RIGHTS write on a trusted-owner dir", dir([ace("S-1-3-4", MODIFY)]), "final", null],
    ["junction ancestor", dir([], { reparse: true }), "ancestor", /reparse point/],
    ["file where a directory is expected", dir([], { directory: false }), "final", /not a directory/],
    ["missing component", { path: "C:\\x", exists: false }, "final", /missing/],
    ["user-owned host.cmd readable by Users", exe([ace(USERS, READ_EXECUTE)]), "executable", null],
    ["host.exe", exe([], { path: "C:\\x\\host.exe" }), "executable", null],
    ["extensionless host", exe([], { path: "C:\\x\\host" }), "executable", /not a \.exe/],
    ["host.ps1", exe([], { path: "C:\\x\\host.ps1" }), "executable", /not a \.exe/],
    ["symlinked host.cmd", exe([], { reparse: true }), "executable", /reparse point/],
    ["directory as host", exe([], { directory: true }), "executable", /not a regular file/],
    ["Authenticated Users Modify on host", exe([ace(AUTHENTICATED, MODIFY)]), "executable", /grants S-1-5-11/],
    ["Everyone GENERIC_WRITE on host", exe([ace(EVERYONE, 0x40000000)]), "executable", /grants S-1-1-0/],
    ["Everyone Delete on host", exe([ace(EVERYONE, 0x10000)]), "executable", /grants S-1-1-0/],
    ["negative generic mask (GENERIC_READ|GENERIC_WRITE) on host", exe([ace(EVERYONE, -1073741824)]), "executable", /grants S-1-1-0/],
    ["manifest readable by Users", exe([ace(USERS, READ_EXECUTE)], { path: "C:\\x\\m.json" }), "manifest", null],
    ["manifest writable by Users", exe([ace(USERS, MODIFY)], { path: "C:\\x\\m.json" }), "manifest", /grants S-1-5-32-545/],
    ["host owned by another user", exe([], { owner: "S-1-5-21-9-9-9-500" }), "executable", /owned by untrusted/],
  ];
  for (const [name, item, kind, expected] of cases) {
    const risk = win32PathRisk(item, kind, USER);
    if (expected === null) assert.equal(risk, null, name);
    else assert.match(risk ?? "", expected, name);
  }
});

test("win32DirectoryChain lists every component from a local drive root and refuses UNC and \\\\?\\ roots", () => {
  assert.deepEqual(win32DirectoryChain("C:\\h\\run\\hosts"), ["C:\\", "C:\\h", "C:\\h\\run", "C:\\h\\run\\hosts"]);
  for (const dir of ["\\\\server\\share\\a", "\\\\?\\C:\\h\\hosts", "\\\\.\\C:\\h"]) assert.throws(() => win32DirectoryChain(dir), /not on a local drive-letter path/, dir);
});

test("isWin32RegistryKey admits only per-user NativeMessagingHosts keys under HKCU\\Software", () => {
  for (const key of ["HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts", "HKCU\\Software\\Chromium\\NativeMessagingHosts", "HKCU\\Software\\t\\NativeMessagingHosts"]) assert.equal(isWin32RegistryKey(key), true, key);
  for (const key of ["HKLM\\Software\\Google\\Chrome\\NativeMessagingHosts", "HKCU\\Software\\Google\\Chrome", "HKCU\\Software", "HKCU\\Environment\\NativeMessagingHosts", "HKCU\\Software\\a\\\\NativeMessagingHosts", "HKCU\\Software\\a\r\nb\\NativeMessagingHosts", undefined]) assert.equal(isWin32RegistryKey(key), false, String(key));
});
