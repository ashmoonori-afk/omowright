import { parse } from "acorn";

// Resolve references after visiting the entire tree so hoisted and forward
// declarations count, without making a sibling block's bindings visible.
export function analyzeScopes(source) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true });
  const references = [];
  const scope = (parent, kind) => ({ parent, kind, bindings: new Set() });
  const root = scope(null, "function");
  function bind(node, current) {
    if (!node) return;
    switch (node.type) {
      case "Identifier": current.bindings.add(node.name); break;
      case "RestElement": bind(node.argument, current); break;
      case "AssignmentPattern": bind(node.left, current); break;
      case "ArrayPattern": node.elements.forEach(item => bind(item, current)); break;
      case "ObjectPattern":
        node.properties.forEach(item => bind(item.type === "RestElement" ? item.argument : item.value, current));
        break;
    }
  }
  function defaults(node, current) {
    if (!node) return;
    if (node.type === "AssignmentPattern") {
      visit(node.right, current);
      defaults(node.left, current);
    } else if (node.type === "ObjectPattern") {
      for (const property of node.properties) {
        if (property.computed) visit(property.key, current);
        defaults(property.value ?? property.argument, current);
      }
    } else if (node.type === "ArrayPattern") {
      node.elements.forEach(item => defaults(item, current));
    } else if (node.type === "RestElement") defaults(node.argument, current);
  }
  function children(node, current, excluded = []) {
    for (const [key, value] of Object.entries(node)) {
      if (excluded.includes(key)) continue;
      if (Array.isArray(value)) value.forEach(item => visit(item, current));
      else if (value?.type) visit(value, current);
    }
  }
  function visit(node, current) {
    if (!node?.type) return;
    switch (node.type) {
      case "Identifier":
        references.push({ name: node.name, node, scope: current });
        return;
      case "PrivateIdentifier": return;
      case "ImportDeclaration":
        node.specifiers.forEach(item => bind(item.local, current));
        return;
      case "ExportAllDeclaration": return;
      case "ExportNamedDeclaration":
        visit(node.declaration, current);
        if (!node.source) node.specifiers.forEach(item => visit(item.local, current));
        return;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression": {
        if (node.type === "FunctionDeclaration") bind(node.id, current);
        const local = scope(current, "function");
        bind(node.id, local);
        if (node.type !== "ArrowFunctionExpression") local.bindings.add("arguments");
        node.params.forEach(param => bind(param, local));
        node.params.forEach(param => defaults(param, local));
        // Body var declarations are not visible to parameter initializers.
        visit(node.body, scope(local, "function"));
        return;
      }
      case "ClassDeclaration":
      case "ClassExpression": {
        if (node.type === "ClassDeclaration") bind(node.id, current);
        const local = scope(current, "block");
        bind(node.id, local);
        visit(node.superClass, local);
        visit(node.body, local);
        return;
      }
      case "BlockStatement":
      case "StaticBlock":
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement":
      case "SwitchStatement":
        children(node, scope(current, node.type === "StaticBlock" ? "function" : "block"));
        return;
      case "CatchClause": {
        const local = scope(current, "block");
        bind(node.param, local);
        defaults(node.param, local);
        visit(node.body, local);
        return;
      }
      case "VariableDeclaration": {
        let target = current;
        if (node.kind === "var") while (target.kind !== "function") target = target.parent;
        for (const declaration of node.declarations) {
          bind(declaration.id, target);
          defaults(declaration.id, current);
          visit(declaration.init, current);
        }
        return;
      }
      case "MemberExpression":
        visit(node.object, current);
        if (node.computed) visit(node.property, current);
        return;
      case "Property":
      case "MethodDefinition":
      case "PropertyDefinition":
        if (node.computed) visit(node.key, current);
        visit(node.value, current);
        return;
      case "LabeledStatement": visit(node.body, current); return;
      case "BreakStatement":
      case "ContinueStatement": return;
      case "MetaProperty": return;
    }
    children(node, current);
  }
  visit(ast, root);
  const free = references.filter(reference => {
    for (let current = reference.scope; current; current = current.parent) {
      if (current.bindings.has(reference.name)) return false;
    }
    return true;
  });
  return { ast, references, free };
}
