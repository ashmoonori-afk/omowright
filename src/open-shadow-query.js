// Self-contained because locator queries serialize this into the frame's page or isolated world.
// Order matches the CSS locator traversal: the scope's own matches, then each open shadow root below
// it, depth first in document order, nested roots included. Closed roots stay excluded.
// A selector with combinators also matches across open shadow boundaries (a host is the parent of its
// shadow root's top-level children), but matching never climbs above the scope, and an element scope
// anchors the selector to itself: `:scope` and leading compounds resolve inside it, not against its ancestors.
export function queryOpenShadowAll(root, selector) {
  const groups = [];
  let parts = [], token = "", depth = 0, quote = "", escaped = false, combinator = " ";
  const flush = () => {
    if (!token.trim()) return;
    parts.push({ selector: token.trim(), combinator });
    token = "";
    combinator = " ";
  };
  for (const char of selector) {
    if (escaped) { token += char; escaped = false; continue; }
    if (char === "\\") { token += char; escaped = true; continue; }
    if (quote) { token += char; if (char === quote) quote = ""; continue; }
    if (char === '"' || char === "'") { quote = char; token += char; continue; }
    if (char === "[" || char === "(") depth++;
    if (char === "]" || char === ")") depth--;
    if (!depth && (char === "," || char === ">" || char === "+" || char === "~" || /\s/.test(char))) {
      flush();
      if (char === ",") { groups.push(parts); parts = []; combinator = " "; }
      else if (!/\s/.test(char)) combinator = char;
    } else token += char;
  }
  flush();
  groups.push(parts);
  // One compound per group matches the same nodes in every tree scope, so each scope stays a native query.
  const simple = groups.every(parts => parts.length === 1 && !/^:scope\b/.test(parts[0].selector));
  let rootSelector = selector;
  if (!simple && root instanceof Element) {
    const scopedSelectors = [];
    for (const parts of groups) {
      const first = parts[0].selector;
      const rest = parts.slice(1).map(part => `${part.combinator} ${part.selector}`).join(" ");
      const scoped = /^:scope\b/.test(first);
      scopedSelectors.push(`${scoped ? "" : ":scope "}${first} ${rest}`);
      if (!scoped && parts.length > 1 && root.matches(first)) scopedSelectors.push(`:scope ${rest}`);
    }
    rootSelector = scopedSelectors.join(", ");
  }
  const rootElements = root.querySelectorAll("*");
  const rootMatches = rootSelector === "*" ? rootElements : root.querySelectorAll(rootSelector);
  // A stack of open roots, popped depth first; the scope's own shadow root comes first.
  const pending = [];
  for (let index = rootElements.length - 1; index >= 0; index--) {
    if (rootElements[index].shadowRoot) pending.push(rootElements[index].shadowRoot);
  }
  if (root instanceof Element && root.shadowRoot) pending.push(root.shadowRoot);
  if (pending.length === 0) return Array.from(rootMatches);
  const results = [];
  // Index loops, never spread: a scope can hold more nodes than the engine's argument limit.
  for (let index = 0; index < rootMatches.length; index++) results.push(rootMatches[index]);
  const parent = node => node.parentElement ?? node.getRootNode().host ?? null;
  const scope = root instanceof Element ? root : root.documentElement;
  const matches = (node, parts, index) => {
    if (node === root && index > 0) return false;
    const part = parts[index];
    const scoped = /^:scope\b/.test(part.selector);
    const compound = scoped ? part.selector.replace(/^:scope\b/, "*") : part.selector;
    if (scoped && node !== scope) return false;
    if (!node.matches(compound)) return false;
    if (index === 0) return true;
    if (part.combinator === ">") {
      const ancestor = parent(node);
      return !!ancestor && matches(ancestor, parts, index - 1);
    }
    if (part.combinator === "+") return !!node.previousElementSibling && matches(node.previousElementSibling, parts, index - 1);
    if (part.combinator === "~") {
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (matches(sibling, parts, index - 1)) return true;
      }
      return false;
    }
    for (let ancestor = parent(node); ancestor; ancestor = parent(ancestor)) {
      if (matches(ancestor, parts, index - 1)) return true;
      if (ancestor === root) break;
    }
    return false;
  };
  while (pending.length) {
    const shadow = pending.pop();
    const elements = shadow.querySelectorAll("*");
    for (let index = elements.length - 1; index >= 0; index--) {
      if (elements[index].shadowRoot) pending.push(elements[index].shadowRoot);
    }
    if (simple) {
      const found = selector === "*" ? elements : shadow.querySelectorAll(selector);
      for (let index = 0; index < found.length; index++) results.push(found[index]);
      continue;
    }
    for (let index = 0; index < elements.length; index++) {
      const node = elements[index];
      if (groups.some(parts => matches(node, parts, parts.length - 1))) results.push(node);
    }
  }
  return results;
}
