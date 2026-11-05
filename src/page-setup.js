import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { acquireNetwork } from "./network-events.js";
import { validateViewport, repinViewport } from "./viewport.js";

const states = new WeakMap();

// The same codec runs on both sides of Runtime's string-only binding transport.
function bindingValue(value, decode = false) {
  if (decode) {
    const [type, data] = value;
    if (type === "undefined") return undefined;
    if (type === "number") return data === "-0" ? -0 : Number(data);
    if (type === "bigint") return BigInt(data);
    if (type === "array") return data.map(item => bindingValue(item, true));
    if (type === "object") return Object.fromEntries(data.map(([key, item]) => [key, bindingValue(item, true)]));
    return data;
  }
  if (value === undefined) return ["undefined"];
  if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) return ["number", Object.is(value, -0) ? "-0" : String(value)];
  if (typeof value === "bigint") return ["bigint", String(value)];
  if (Array.isArray(value)) return ["array", value.map(item => bindingValue(item))];
  if (value !== null && typeof value === "object") return ["object", Object.entries(value).map(([key, item]) => [key, bindingValue(item)])];
  return ["value", value];
}

function bindingScript(name, internalName) {
  return `(() => {
    const name = ${JSON.stringify(name)};
    if (globalThis[name]?.__omowrightBinding) return;
    const bindingValue = ${bindingValue.toString()};
    const raw = globalThis[${JSON.stringify(internalName)}];
    let sequence = 0;
    const callbacks = new Map();
    const fn = (...args) => new Promise((resolve, reject) => {
      const id = ++sequence;
      callbacks.set(id, { resolve, reject });
      try { raw(JSON.stringify({ id, args: bindingValue(args) })); }
      catch (error) { callbacks.delete(id); reject(error); }
    });
    fn.__omowrightBinding = { callbacks, bindingValue };
    globalThis[name] = fn;
  })()`;
}

export function hasPageBindings(page) {
  return (states.get(page)?.bindings.size ?? 0) > 0;
}

function setupState(page) {
  let state = states.get(page);
  if (state) return state;
  state = { scripts: [], bindings: new Map(), sessions: new Map(), headers: null, media: null };
  states.set(page, state);
  // FrameManager calls this before resuming a paused out-of-process child.
  page.frameManager.sessionSetup = sessionId => initializeSession(page, state, sessionId);
  const offBinding = page.cdp.on("Runtime.bindingCalled", (event, meta) => {
    const binding = state.bindings.get(event.name);
    if (!binding || !state.sessions.has(meta.sessionId)) return;
    deliverBinding(page, state, binding, event, meta.sessionId).catch(() => {
      // A navigation or detached frame can destroy the calling context while
      // its host callback is still running. There is then no promise to settle.
    });
  });
  const offDetached = page.cdp.on("Target.detachedFromTarget", ({ sessionId }) => {
    state.sessions.get(sessionId)?.releaseNetwork?.();
    state.sessions.delete(sessionId);
  });
  page.events.on("close", async () => {
    offBinding();
    offDetached();
    states.delete(page);
    delete page.frameManager.sessionSetup;
    for (const [sessionId, session] of state.sessions) {
      session.releaseNetwork?.();
      for (const identifier of session.scripts.values()) {
        await page.cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier }, sessionId).catch(() => {});
      }
      for (const name of session.bindings) {
        await page.cdp.send("Runtime.removeBinding", { name }, sessionId).catch(() => {});
      }
      if (state.bindings.size) await page.cdp.send("Runtime.disable", undefined, sessionId).catch(() => {});
    }
  });
  return state;
}

async function deliverBinding(page, state, binding, event, sessionId) {
  const call = JSON.parse(event.payload);
  let result;
  try {
    const args = bindingValue(call.args, true);
    if (binding.source) {
      const frameId = page.frameManager.mainWorldContexts.get(`${sessionId}:${event.executionContextId}`);
      const frame = page.frames().find(frame => frame.frameId === frameId);
      if (!frame) throw Error("Binding caller frame is detached");
      args.unshift({ context: page.context(), page, frame });
    }
    result = { value: bindingValue(await binding.callback(...args)) };
  } catch (error) {
    result = error instanceof Error
      ? { error: { name: error.name, message: error.message, stack: error.stack } }
      : { thrown: bindingValue(error) };
  }
  if (states.get(page) !== state || !state.sessions.has(sessionId)) return;
  await page.cdp.send("Runtime.evaluate", {
    contextId: event.executionContextId,
    expression: `(() => {
      const state = globalThis[${JSON.stringify(binding.name)}].__omowrightBinding;
      const callback = state.callbacks.get(${call.id});
      state.callbacks.delete(${call.id});
      const result = ${JSON.stringify(result)};
      if (result.error) {
        const error = new Error(result.error.message);
        error.name = result.error.name; error.stack = result.error.stack;
        callback.reject(error);
      } else if (result.thrown) callback.reject(state.bindingValue(result.thrown, true));
      else callback.resolve(state.bindingValue(result.value, true));
    })()`,
  }, sessionId);
}

async function installScripts(page, state, sessionId, session) {
  for (const script of state.scripts) {
    if (session.scripts.has(script)) continue;
    const { identifier } = await page.cdp.send("Page.addScriptToEvaluateOnNewDocument",
      { source: script.source, runImmediately: script.binding }, sessionId);
    session.scripts.set(script, identifier);
  }
}

function initializeSession(page, state, sessionId) {
  let session = state.sessions.get(sessionId);
  if (!session) {
    session = { scripts: new Map(), bindings: new Set(), ready: Promise.resolve() };
    state.sessions.set(sessionId, session);
  }
  // Explicit setup calls can overlap the automatic OOPIF attach path.
  const operation = session.ready.then(async () => {
    for (const [name] of state.bindings) {
      if (session.bindings.has(name)) continue;
      await page.cdp.send("Runtime.addBinding", { name }, sessionId);
      session.bindings.add(name);
    }
    if (state.bindings.size && !session.runtimeEnabled) {
      await page.cdp.send("Runtime.enable", undefined, sessionId);
      session.runtimeEnabled = true;
    }
    await installScripts(page, state, sessionId, session);
    if (state.headers !== null) {
      session.releaseNetwork ??= acquireNetwork(page.cdp, sessionId);
      await session.releaseNetwork.ready;
      await page.cdp.send("Network.setExtraHTTPHeaders", { headers: state.headers }, sessionId);
    }
    if (state.media) await page.cdp.send("Emulation.setEmulatedMedia", state.media, sessionId);
  });
  session.ready = operation.catch(() => {});
  return operation;
}

async function updateSessions(page, state) {
  const main = await page.resolveSessionId();
  const sessions = new Set([main, ...[...page.frameManager.frames.values()].map(frame => frame.sessionId)]);
  for (const sessionId of sessions) {
    await initializeSession(page, state, sessionId);
    await page.cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
  }
}

export async function addInitScript(script, arg) {
  let source;
  if (typeof script === "function") {
    source = `(() => { const __name = value => value; (${script.toString()})(${JSON.stringify(arg) ?? "undefined"}); })()`;
  } else if (typeof script === "string") source = script;
  else if (typeof script?.content === "string") source = script.content;
  else if (typeof script?.path === "string") source = await readFile(script.path, "utf8");
  else throw new TypeError("addInitScript requires a function, string, or { path | content }");
  const state = setupState(this);
  state.scripts.push({ source, binding: false });
  await updateSessions(this, state);
}

export async function exposeFunction(name, callback) {
  await registerBinding(this, name, callback, false);
}

export async function exposeBinding(name, callback) {
  await registerBinding(this, name, callback, true);
}

async function registerBinding(page, name, callback, source) {
  if (typeof name !== "string" || typeof callback !== "function") throw new TypeError(`${source ? "exposeBinding" : "exposeFunction"} requires a name and function`);
  const state = setupState(page);
  if ([...state.bindings.values()].some(binding => binding.name === name)) throw Error(`Function "${name}" has already been registered`);
  const internalName = `__omowright_binding_${randomUUID().replaceAll("-", "")}`;
  state.bindings.set(internalName, { name, callback, source });
  state.scripts.push({ source: bindingScript(name, internalName), binding: true });
  await updateSessions(page, state);
}

export async function setExtraHTTPHeaders(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new TypeError("headers must be an object of strings");
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string") throw new TypeError(`Header "${name}" value must be a string`);
  }
  const state = setupState(this);
  state.headers = { ...headers };
  await updateSessions(this, state);
}

export async function setViewportSize(viewport) {
  const size = validateViewport(viewport);
  if (this.browser.setViewportSize) await this.browser.setViewportSize(size);
  else await repinViewport(this, size);
}

const mediaFeatures = {
  colorScheme: ["prefers-color-scheme", ["light", "dark", "no-preference"]],
  reducedMotion: ["prefers-reduced-motion", ["reduce", "no-preference"]],
  forcedColors: ["forced-colors", ["active", "none"]],
  contrast: ["prefers-contrast", ["more", "no-preference"]],
};

export async function emulateMedia(options = {}) {
  if (options.media !== undefined && options.media !== null && !["screen", "print"].includes(options.media)) throw new TypeError("media must be screen, print or null");
  for (const [key, [, allowed]] of Object.entries(mediaFeatures)) {
    if (options[key] !== undefined && options[key] !== null && !allowed.includes(options[key])) throw new TypeError(`${key} must be ${allowed.join(", ")} or null`);
  }
  const state = setupState(this);
  const previous = new Map(state.media?.features.map(feature => [feature.name, feature.value]));
  for (const [key, [name]] of Object.entries(mediaFeatures)) {
    if (options[key] !== undefined) previous.set(name, options[key] ?? "");
  }
  state.media = {
    media: options.media === undefined ? state.media?.media ?? "" : options.media ?? "",
    features: [...previous].map(([name, value]) => ({ name, value })),
  };
  await updateSessions(this, state);
}
