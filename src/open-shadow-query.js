// Self-contained because locator queries serialize this into the frame's page or isolated world.
// Order matches the CSS locator traversal: each scope's own matches, then its open shadow roots.
export function queryOpenShadowAll(root, selector) {
  const scan = scope => {
    const elements = scope.querySelectorAll("*");
    const shadows = scope instanceof Element && scope.shadowRoot ? [scope.shadowRoot] : [];
    for (let index = 0; index < elements.length; index++) {
      const shadow = elements[index].shadowRoot;
      if (shadow) shadows.push(shadow);
    }
    return { matches: selector === "*" ? elements : scope.querySelectorAll(selector), shadows };
  };
  const top = scan(root);
  if (top.shadows.length === 0) return Array.from(top.matches);
  const results = [];
  const visit = ({ matches, shadows }) => {
    for (let index = 0; index < matches.length; index++) results.push(matches[index]);
    for (const shadow of shadows) visit(scan(shadow));
  };
  visit(top);
  return results;
}
