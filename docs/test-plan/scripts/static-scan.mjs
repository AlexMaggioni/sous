// Static facts per test file: runtime imports from src, tests, assertions per test, tests with no call into imported names.
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
const root = resolve(process.argv[2]);
const ts = createRequire(join(root, "package.json"))("typescript");
const walk = (d, o = []) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p, o); else if (n.endsWith(".test.ts")) o.push(p); } return o; };
const out = [];
for (const pkg of ["engine", "orc", "harnesses"]) for (const file of walk(join(root, "packages", pkg, "test"))) {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const runtime = new Set(); // names imported at runtime from src or other packages
  let typeOnlyImports = 0;
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st)) continue;
    const spec = st.moduleSpecifier.text;
    if (spec.startsWith("node:") || spec === "typebox") continue;
    const helper = /helpers\/|\/fixture|\.\/orc/.test(spec);
    const c = st.importClause;
    if (!c) continue;
    if (c.isTypeOnly) { typeOnlyImports++; continue; }
    if (c.name) runtime.add(c.name.text);
    const nb = c.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) runtime.add(nb.name.text);
    if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) if (!el.isTypeOnly) runtime.add(el.name.text);
    void helper;
  }
  // local helper functions that (transitively) use a runtime import count as runtime too
  const tests = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) ? `${callee.expression.text}.${callee.name.text}` : "";
      if (/^(test|it)(\.only|\.skip|\.todo)?$/.test(name) && node.arguments.length >= 2 && (ts.isStringLiteralLike(node.arguments[0]) || ts.isTemplateExpression(node.arguments[0]))) {
        const body = node.arguments[node.arguments.length - 1];
        const title = node.arguments[0].getText(sf).slice(1, -1);
        let asserts = 0, idents = new Set(), calls = 0;
        const inner = (n) => {
          if (ts.isCallExpression(n)) { const t = n.expression.getText(sf); if (/^assert(\.|$)|^expect|\.rejects|\.throws/.test(t)) asserts++; calls++; }
          if (ts.isIdentifier(n)) idents.add(n.text);
          ts.forEachChild(n, inner);
        };
        inner(body);
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
        tests.push({ title, line, lines: end - line + 1, asserts, usesRuntime: [...idents].filter((i) => runtime.has(i)), idents: [...idents] });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // top-level functions/consts and what runtime names they touch
  const localUses = new Map();
  for (const st of sf.statements) {
    const names = [];
    if (ts.isFunctionDeclaration(st) && st.name) names.push(st.name.text);
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.push(d.name.text);
    if (!names.length) continue;
    const idents = new Set(); const inner = (n) => { if (ts.isIdentifier(n)) idents.add(n.text); ts.forEachChild(n, inner); }; inner(st);
    for (const n of names) localUses.set(n, idents);
  }
  const reaches = (name, seen = new Set()) => { if (runtime.has(name)) return true; if (seen.has(name) || !localUses.has(name)) return false; seen.add(name); for (const i of localUses.get(name)) if (i !== name && reaches(i, seen)) return true; return false; };
  for (const t of tests) t.reachesSrc = t.idents.some((i) => reaches(i));
  out.push({ file: relative(root, file), lines: text.split("\n").length - 1, runtimeImports: runtime.size, typeOnlyImports, tests: tests.map(({ idents, ...t }) => t) });
}
console.log(JSON.stringify(out));
