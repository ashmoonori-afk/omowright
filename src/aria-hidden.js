// Self-contained because role locator queries serialize this into the frame's isolated world.
// Port of Playwright's isElementHiddenForAria (packages/injected/src/roleUtils.ts): getByRole skips the elements it
// reports unless includeHidden is set. `cache` memoizes the ancestor walk for one query.
export function isElementHiddenForAria(element, cache) {
  const getStyle = node => node.ownerDocument?.defaultView?.getComputedStyle(node);
  const isVisibleTextNode = text => {
    const range = text.ownerDocument.createRange();
    range.selectNode(text);
    const rect = range.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const belongsToDisplayNoneOrAriaHiddenOrNonSlotted = node => {
    let hidden = cache.get(node);
    if (hidden === undefined) {
      // Light-DOM children of a shadow host render only when a slot takes them.
      hidden = !!(node.parentElement && node.parentElement.shadowRoot && !node.assignedSlot);
      if (!hidden) {
        const style = getStyle(node);
        hidden = !style || style.display === "none" || node.getAttribute("aria-hidden")?.toLowerCase() === "true";
      }
      if (!hidden) {
        const parent = node.parentElement ?? (node.parentNode?.nodeType === 11 ? node.parentNode.host : null);
        if (parent) hidden = belongsToDisplayNoneOrAriaHiddenOrNonSlotted(parent);
      }
      cache.set(node, hidden);
    }
    return hidden;
  };
  // A form's named controls can shadow its tagName.
  const tagName = typeof element.tagName === "string" ? element.tagName.toUpperCase() : "FORM";
  if (["STYLE", "SCRIPT", "NOSCRIPT", "TEMPLATE"].includes(tagName)) return true;
  const style = getStyle(element);
  const isSlot = element.nodeName === "SLOT";
  if (style?.display === "contents" && !isSlot) {
    // display:contents is not rendered itself, but its child nodes are.
    for (let child = element.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1 && !isElementHiddenForAria(child, cache)) return false;
      if (child.nodeType === 3 && isVisibleTextNode(child)) return false;
    }
    return true;
  }
  // <option> inside <select> and <slot> ignore visibility and content-visibility; checkVisibility() covers
  // content-visibility and closed <details> up the flat tree.
  const isOptionInsideSelect = element.nodeName === "OPTION" && !!element.closest("select");
  if (!isOptionInsideSelect && !isSlot && style && (!element.checkVisibility() || style.visibility !== "visible")) return true;
  return belongsToDisplayNoneOrAriaHiddenOrNonSlotted(element);
}
