const baselines = new WeakMap();
const REF_LINE = /^(\s*)- [^\s"]+(?: "(?:\\.|[^"\\])*")? \[ref=((?:f\d+)?e\d+)\]/;

// Compare the final, frame-inlined tree so values, selected options and text children use
// exactly the same escaping and password redaction as a full snapshot.
function indexTree(tree) {
  const nodes = new Map();
  const unreferenced = [];
  const parents = [];
  let focused = null;
  for (const line of tree.split("\n")) {
    if (!line) continue;
    const depth = line.search(/\S/);
    while (parents.length && parents.at(-1).depth >= depth) parents.pop();
    const match = REF_LINE.exec(line);
    if (match) {
      const ref = match[2];
      const node = { ref, tree: line.trim().slice(2) };
      nodes.set(ref, node);
      parents.push({ depth, node });
      // Strip the quoted name before looking at state, not user-supplied name text.
      const state = line.slice(match[0].length).match(/"(?:\\.|[^"\\])*"|\[focused\]/g) ?? [];
      if (state.includes("[focused]")) focused = ref;
    } else if (parents.length) {
      parents.at(-1).node.tree += ` | ${line.trim().slice(2)}`;
    } else if (!/^\s*- [\w-]+:?$/.test(line)) {
      unreferenced.push(line);
    }
  }
  return { nodes, focused, unreferenced: unreferenced.join("\n") };
}

export function snapshotResult(frameManager, options, snapshot) {
  const { diff, ...scope } = options;
  const document = frameManager.getFrame(frameManager.mainFrameId);
  const contexts = JSON.stringify(frameManager.collectDescendantFrames(frameManager.mainFrameId)
    .map(({ frameId }) => [frameId, frameManager.getFrame(frameId)?.isolatedContextId]));
  const scopeKey = JSON.stringify(scope);
  const current = indexTree(snapshot.tree);
  const previous = baselines.get(frameManager);
  // Store private, derived data, not the caller-mutable refs map or returned delta entries.
  baselines.set(frameManager, { ...current, document, contexts, scopeKey });
  if (diff !== true) return snapshot;
  let reason;
  if (!previous) reason = "no-baseline";
  else if (previous.document !== document || previous.contexts !== contexts) reason = "navigation";
  else if (previous.scopeKey !== scopeKey) reason = "options-changed";
  else if (previous.unreferenced !== current.unreferenced) reason = "unreferenced-content";
  if (reason) return { ...snapshot, full: true, reason };

  const added = [];
  const changed = [];
  const removed = [];
  for (const [ref, node] of current.nodes) {
    const before = previous.nodes.get(ref);
    if (!before) added.push({ ...node });
    else if (before.tree !== node.tree) {
      // A stable ref already identifies the role and name. Do not resend its unchanged
      // label or placeholder on every keystroke; the remaining text is current state/value.
      const label = /^[^\s"]+(?: "(?:\\.|[^"\\])*")? /;
      let tree = node.tree;
      const heading = label.exec(tree)?.[0];
      if (heading && heading === label.exec(before.tree)?.[0]) tree = tree.slice(heading.length);
      const placeholder = / \[placeholder="(?:\\.|[^"\\])*"\]/.exec(tree)?.[0];
      if (placeholder && before.tree.includes(placeholder)) tree = tree.replace(placeholder, "");
      changed.push({ ref, tree });
    }
  }
  for (const ref of previous.nodes.keys()) if (!current.nodes.has(ref)) removed.push(ref);
  const result = { diff: { added, changed, removed, focused: current.focused }, full: false };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > Buffer.byteLength(snapshot.tree, "utf8")) {
    return { ...snapshot, full: true, reason: "diff-larger-than-full" };
  }
  return result;
}
