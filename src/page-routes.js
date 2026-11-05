import { readFile } from "node:fs/promises";
import { createRoutes } from "./routes.js";

const predicates = new WeakMap();
const handlers = new WeakMap();
const abortReasons = {
  aborted: "Aborted", accessdenied: "AccessDenied", addressunreachable: "AddressUnreachable",
  blockedbyclient: "BlockedByClient", blockedbyresponse: "BlockedByResponse",
  connectionaborted: "ConnectionAborted", connectionclosed: "ConnectionClosed",
  connectionfailed: "ConnectionFailed", connectionrefused: "ConnectionRefused",
  connectionreset: "ConnectionReset", internetdisconnected: "InternetDisconnected",
  namenotresolved: "NameNotResolved", timedout: "TimedOut", failed: "Failed",
};

function urlMatcher(match) {
  if (typeof match === "function") {
    if (!predicates.has(match)) predicates.set(match, request => match(new URL(request.url)));
    return predicates.get(match);
  }
  if (match instanceof RegExp) {
    // Avoid stateful /g and /y matching while keeping unroute's pattern identity.
    return new RegExp(match.source, match.flags.replace(/[gy]/g, ""));
  }
  if (typeof match !== "string") throw new TypeError("url must be a glob string, RegExp or predicate");
  let source = "";
  let groups = 0;
  for (let index = 0; index < match.length; index += 1) {
    const char = match[index];
    if (char === "\\") {
      const literal = match[++index] ?? "\\";
      source += literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (char === "*") {
      const start = index;
      while (match[index + 1] === "*") index += 1;
      const deep = index > start && (start === 0 || match[start - 1] === "/") &&
        (index + 1 === match.length || match[index + 1] === "/");
      if (deep && match[index + 1] === "/") {
        source += "(?:.*/)?";
        index += 1;
      } else source += deep ? ".*" : "[^/]*";
    } else if (char === "{") { source += "(?:"; groups += 1; }
    else if (char === "}" && groups > 0) { source += ")"; groups -= 1; }
    else if (char === "," && groups > 0) source += "|";
    else source += char.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

function adaptHandler(handler) {
  if (typeof handler !== "function") throw new TypeError("handler must be a function");
  if (!handlers.has(handler)) handlers.set(handler, raw => {
    const request = {
      url: () => raw.request.url,
      method: () => raw.request.method,
      headers: () => Object.fromEntries(Object.entries(raw.request.headers).map(([key, value]) => [key.toLowerCase(), value])),
      postData: () => raw.request.postData ?? null,
      resourceType: () => raw.request.resourceType?.toLowerCase(),
    };
    const route = {
      request: () => request,
      continue: overrides => raw.continue(overrides),
      fallback: () => raw.fallback(),
      abort(errorCode = "failed") {
        const reason = abortReasons[errorCode];
        if (!reason) throw new TypeError(`Unknown error code: ${errorCode}`);
        return raw.abort(reason);
      },
      async fulfill(options = {}) {
        let { body, contentType } = options;
        if (options.json !== undefined) {
          body = JSON.stringify(options.json);
          contentType ??= "application/json";
        } else if (options.path !== undefined) {
          body = await readFile(options.path);
        }
        return raw.fulfill({ ...options, body, contentType });
      },
    };
    return handler(route, request);
  });
  return handlers.get(handler);
}

export function pageRoute(page, match, handler, options = {}) {
  return createRoutes(page).route(urlMatcher(match), adaptHandler(handler), { times: options.times, prepend: true });
}

export function pageUnroute(page, match, handler) {
  return createRoutes(page).unroute(urlMatcher(match), handler === undefined ? undefined : adaptHandler(handler));
}

export function pageUnrouteAll(page) {
  return createRoutes(page).unroute();
}
