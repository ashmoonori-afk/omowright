// Self-contained because locator queries serialize this into the frame's isolated world.
export function queryShadowAll(root, selector) {
  const nativeMatches = Array.from(root.querySelectorAll(selector));
  // Discover roots without retaining every element or spreading a DOM-sized argument list.
  const scopes = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    scopes.push(current);
    const elements = current.querySelectorAll("*");
    for (let index = elements.length - 1; index >= 0; index--) {
      if (elements[index].shadowRoot) pending.push(elements[index].shadowRoot);
    }
    if (current instanceof Element && current.shadowRoot) pending.push(current.shadowRoot);
  }
  // Native matching handles the common shadow-free document without a per-element JS matcher.
  if (scopes.length === 1 && !(root instanceof Element)) return nativeMatches;
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
  const parent = node => node.parentElement ?? node.getRootNode().host ?? null;
  const scope = root instanceof Document ? root.documentElement : root;
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
  // Anchor native selectors to an element scope, including chains starting at the scope itself.
  let result = nativeMatches;
  if (root instanceof Element) {
    const scopedSelectors = [];
    for (const parts of groups) {
      const first = parts[0].selector;
      const rest = parts.slice(1).map(part => `${part.combinator} ${part.selector}`).join(" ");
      const scoped = /^:scope\b/.test(first);
      scopedSelectors.push(`${scoped ? "" : ":scope "}${first} ${rest}`);
      if (!scoped && parts.length > 1 && root.matches(first)) scopedSelectors.push(`:scope ${rest}`);
    }
    result = Array.from(root.querySelectorAll(scopedSelectors.join(", ")));
  }
  for (let index = 1; index < scopes.length; index++) {
    for (const node of scopes[index].querySelectorAll("*")) {
      if (groups.some(parts => matches(node, parts, parts.length - 1))) result.push(node);
    }
  }
  return result;
}
