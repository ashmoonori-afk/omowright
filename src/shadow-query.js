// Self-contained because locator queries serialize this into the frame's isolated world.
export function queryShadowAll(root, selector) {
  // Let Chromium validate CSS syntax, including selectors inside functional pseudo-classes.
  root.querySelectorAll(selector);
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
  const candidates = [];
  const visit = current => {
    const elements = Array.from(current.querySelectorAll("*"));
    candidates.push(...elements);
    if (current instanceof Element && current.shadowRoot) visit(current.shadowRoot);
    for (const element of elements) if (element.shadowRoot) visit(element.shadowRoot);
  };
  visit(root);
  return candidates.filter(node => groups.some(parts => matches(node, parts, parts.length - 1)));
}
