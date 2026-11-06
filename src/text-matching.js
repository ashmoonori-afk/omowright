// Self-contained: locator queries serialize this factory into the document's world.
// Playwright's selectorUtils/createTextMatcher and roleUtils define the matching and naming rules.
export function createTextMatching(isHidden = () => false, getRole = () => "", includeHidden = false) {
  const normalize = value => String(value ?? "").replace(/[\u200b\u00ad]/g, "").trim().replace(/\s+/g, " ");
  const matches = (value, matcher) => {
    if (matcher instanceof RegExp) {
      matcher.lastIndex = 0;
      return matcher.test(value);
    }
    const text = normalize(value);
    return "exact" in matcher
      ? text === normalize(matcher.exact)
      : text.toLowerCase().includes(normalize(matcher.contains).toLowerCase());
  };
  const skipped = node => ["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(node.nodeName) ||
    !!node.ownerDocument?.head?.contains(node);
  const textCache = new Map();
  const text = node => {
    if (textCache.has(node)) return textCache.get(node);
    let value = "";
    if (!skipped(node)) {
      if (node.nodeName === "INPUT" && ["submit", "button", "reset"].includes(node.type)) value = node.value;
      else {
        for (const child of node.childNodes) {
          if (child.nodeType === 3) value += child.nodeValue;
          else if (child.nodeType === 1) value += text(child);
        }
        if (node.shadowRoot) value += text(node.shadowRoot);
      }
    }
    textCache.set(node, value);
    return value;
  };
  const matchesText = (node, matcher) => !skipped(node) && matches(text(node), matcher);
  const labelledBy = node => {
    const refs = node.ariaLabelledByElements ?? (node.getAttribute("aria-labelledby") ?? "")
      .trim().split(/\s+/).filter(Boolean).map(id => node.getRootNode().getElementById?.(id)).filter(Boolean);
    return refs.length ? [...new Set(refs)] : null;
  };
  const labels = node => {
    const refs = labelledBy(node);
    if (refs) return refs.map(text);
    const ariaLabel = node.getAttribute("aria-label");
    if (ariaLabel?.trim()) return [ariaLabel];
    return Array.from(node.labels ?? [], text);
  };
  const contentRoles = new Set(["button", "cell", "checkbox", "columnheader", "gridcell", "heading", "link",
    "menuitem", "menuitemcheckbox", "menuitemradio", "option", "radio", "row", "rowheader", "switch",
    "tab", "tooltip", "treeitem"]);
  const prohibitedRoles = new Set(["caption", "code", "definition", "deletion", "emphasis", "generic",
    "insertion", "mark", "paragraph", "presentation", "strong", "subscript", "suggestion", "superscript", "term", "time"]);
  const accessibleName = node => {
    const visited = new Set();
    const alternative = (element, referenced = false, hiddenReference = false, descendant = false, inLabelledBy = false) => {
      if (visited.has(element) || skipped(element)) return "";
      if (!includeHidden && !hiddenReference && isHidden(element)) return "";
      visited.add(element);
      const refs = labelledBy(element);
      if (refs && !inLabelledBy) {
        const value = refs.map(ref => alternative(ref, true, isHidden(ref), false, true)).join(" ");
        if (value) return value;
      }
      const ariaLabel = element.getAttribute("aria-label");
      if (ariaLabel?.trim()) return ariaLabel;
      const tag = element.nodeName;
      if (tag === "INPUT" && ["button", "submit", "reset"].includes(element.type))
        return element.value || ({ submit: "Submit", reset: "Reset" }[element.type]) || element.getAttribute("title") || "";
      if (element.labels?.length && !inLabelledBy)
        return Array.from(element.labels, label => alternative(label, true, isHidden(label))).join(" ");
      if (tag === "IMG" || tag === "AREA" || (tag === "INPUT" && element.type === "image"))
        return element.getAttribute("alt") || element.getAttribute("title") || (tag === "INPUT" ? "Submit" : "");
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        if (descendant && ["INPUT", "TEXTAREA"].includes(tag)) return element.value;
        if (tag === "INPUT" && element.type === "file") return "Choose File";
        const usePlaceholder = tag === "TEXTAREA" || ["text", "password", "number", "search", "tel", "email", "url"].includes(element.type);
        return element.getAttribute("title") || (usePlaceholder ? element.getAttribute("placeholder") : "") || "";
      }
      const nativeChild = { FIELDSET: "LEGEND", FIGURE: "FIGCAPTION", TABLE: "CAPTION", SVG: "title" }[tag];
      const child = nativeChild && Array.from(element.children).find(child => child.nodeName === nativeChild);
      if (child) return alternative(child, true, isHidden(child));
      if (referenced || descendant || tag === "SUMMARY" || contentRoles.has(getRole(element))) {
        let value = "";
        const assigned = tag === "SLOT" ? element.assignedNodes() : [];
        const children = assigned.length ? assigned : [...element.childNodes, ...(element.shadowRoot?.childNodes ?? [])];
        for (const child of children) {
          if (!assigned.length && child.assignedSlot) continue;
          if (child.nodeType === 3) value += child.nodeValue;
          else if (child.nodeType === 1) {
            const token = alternative(child, referenced, hiddenReference, true, inLabelledBy);
            const display = child.ownerDocument.defaultView.getComputedStyle(child).display;
            value += display !== "inline" || child.nodeName === "BR" ? ` ${token} ` : token;
          }
        }
        if (normalize(value)) return value;
      }
      return element.getAttribute("title") || "";
    };
    return prohibitedRoles.has(getRole(node)) ? "" : normalize(alternative(node));
  };
  return { normalize, matches, skipped, text, matchesText, labels, accessibleName };
}
