import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { analyzeScopes } from "./source-scope.mjs";

// Package contract: shipped modules and injected browser code must not depend
// on undeclared bundle bindings. Imports alone do not exercise lazy API paths.
// Explicit standard globals cover the Node host and the browser realm into
// which evaluate callbacks and page-bundle.js are injected, not runner globals.
const globals = new Set(`
  undefined Infinity NaN globalThis
  Object Function Boolean Symbol Error AggregateError EvalError RangeError
  ReferenceError SyntaxError TypeError URIError Number BigInt Math Date String
  RegExp Array Int8Array Uint8Array Uint8ClampedArray Int16Array Uint16Array
  Int32Array Uint32Array BigInt64Array BigUint64Array Float32Array Float64Array
  Map Set WeakMap WeakSet ArrayBuffer SharedArrayBuffer DataView Atomics JSON
  WeakRef FinalizationRegistry Iterator Promise Reflect Proxy Intl WebAssembly
  decodeURI decodeURIComponent encodeURI encodeURIComponent escape unescape
  isFinite isNaN parseFloat parseInt eval
  process Buffer console setTimeout clearTimeout setInterval clearInterval
  setImmediate clearImmediate queueMicrotask structuredClone fetch
  AbortController AbortSignal Blob File FormData Headers Request Response
  URL URLSearchParams TextEncoder TextDecoder performance crypto
  ReadableStream WritableStream TransformStream
  window document location navigator Element HTMLElement HTMLInputElement
  HTMLTextAreaElement Node NodeFilter ShadowRoot MouseEvent WheelEvent
  getComputedStyle innerWidth innerHeight scrollTo MutationObserver
`.trim().split(/\s+/));

const freeNames = source => analyzeScopes(source).free.map(ref => ref.name).sort();

test("scope walk distinguishes bindings, property keys, and undeclared reads and writes", () => {
  assert.deepEqual(freeNames(`
    import { value as imported } from "module";
    const { [key]: local = fallback, ...rest } = imported;
    function outer({ parameter = initial }) {
      before(); function before() {}
      { var hoisted; let hidden; hidden; }
      hoisted; hidden;
      try {} catch (caught) { caught; }
      caught;
      for (let index of rest) { index; }
      index;
      const object = { local, key: local, [computed]: parameter };
      object.member = missing;
      ({ target: assigned } = object);
      return () => arguments[0];
    }
  `), ["assigned", "caught", "computed", "fallback", "hidden", "index", "initial", "key", "missing"]);
  assert.deepEqual(freeNames(`
    const Constructor = class Named { method() { return Named; } };
    Named;
    const recursive = function named() { return named; };
    named;
    class Child extends Constructor { #field; method() { return this.#field; } }
    outer: for (;;) { break outer; }
  `), ["Named", "named"]);
  assert.deepEqual(freeNames("function f(value = bodyOnly) { var bodyOnly; return value; }"), ["bodyOnly"]);
});

test("shipped source has no undeclared identifiers", () => {
  const directory = new URL("../src/", import.meta.url);
  const offenders = [];
  for (const file of readdirSync(directory).filter(file => file.endsWith(".js")).sort()) {
    const { free } = analyzeScopes(readFileSync(new URL(file, directory), "utf8"));
    for (const { name, node } of free) {
      if (!globals.has(name)) offenders.push(`${file}:${node.loc.start.line}:${node.loc.start.column + 1} ${name}`);
    }
  }
  assert.deepEqual(offenders, [], "Package source contains unresolved identifiers:\n" + offenders.join("\n"));
});
