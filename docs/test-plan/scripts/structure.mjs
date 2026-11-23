// Structure facts of the engine: imports between files, node modules per file, cycles, manager methods, option fields.
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
const repo = resolve(process.argv[2]);
const ts = createRequire(join(repo, "package.json"))("typescript");
const walk = (d, o = []) => { for (const n of readdirSync(d)) { const p = join(d, n); if (n === "generated") continue; if (statSync(p).isDirectory()) walk(p, o); else if (n.endsWith(".ts")) o.push(p); } return o; };
for (const pkg of ["engine", "orc", "harnesses"]) {
  const src = join(repo, "packages", pkg, "src");
  const files = walk(src);
  const graph = new Map(), node = new Map(), typeGraph = new Map();
  for (const f of files) {
    const name = relative(src, f);
    const sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true);
    const deps = new Set(), tdeps = new Set(), mods = new Set();
    for (const st of sf.statements) {
      if (!(ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) || !st.moduleSpecifier) continue;
      const spec = st.moduleSpecifier.text;
      const c = ts.isImportDeclaration(st) ? st.importClause : undefined;
      const els = c?.namedBindings && ts.isNamedImports(c.namedBindings) ? c.namedBindings.elements : st.exportClause && ts.isNamedExports(st.exportClause) ? st.exportClause.elements : undefined;
      const typeOnly = Boolean(c?.isTypeOnly || (ts.isExportDeclaration(st) && st.isTypeOnly) || (!c?.name && els?.length && els.every((e) => e.isTypeOnly)));
      if (spec.startsWith(".")) (typeOnly ? tdeps : deps).add(relative(src, resolve(dirname(f), spec)).replace(/\.js$/, ".ts"));
      else if (!typeOnly) mods.add(spec);
    }
    graph.set(name, deps); typeGraph.set(name, tdeps); node.set(name, mods);
  }
  console.log(`\n===== ${pkg}: ${files.length} files`);
  const impure = /^node:(fs|child_process|os|net|http|https|worker_threads|readline|process|vm)(\/|$)/;
  const pure = [...node].filter(([, m]) => ![...m].some((x) => impure.test(x))).map(([n]) => n).sort();
  // transitively pure: reaches no impure file at run time
  const memo = new Map();
  const reachImpure = (n, seen = new Set()) => { if (memo.has(n)) return memo.get(n); if (seen.has(n)) return false; seen.add(n); const mods = node.get(n); if (!mods) return false; let r = [...mods].some((x) => impure.test(x)); if (!r) for (const d of graph.get(n)) if (reachImpure(d, seen)) { r = true; break; } memo.set(n, r); return r; };
  const deepPure = pure.filter((n) => !reachImpure(n));
  console.log(`files with no fs/child_process/os/vm import of their own: ${pure.length}`);
  console.log(`of those, pure through their imports too (${deepPure.length}): ${deepPure.join(", ")}`);
  console.log(`own-pure but reach an impure file: ${pure.filter((n) => !deepPure.includes(n)).join(", ")}`);
  console.log("node modules per impure file:");
  for (const [n, m] of [...node].sort()) { const x = [...m].filter((s) => impure.test(s)); if (x.length) console.log(`  ${n}: ${x.join(" ")}`); }
  // folder-level edges
  const group = (n) => (n.includes("/") ? n.split("/").slice(0, n.startsWith("runs/persistence/") ? 2 : 1).join("/") + "/" : n);
  const edges = new Map();
  for (const [n, deps] of graph) for (const d of deps) { const a = group(n), b = group(d); if (a === b) continue; const k = `${a} -> ${b}`; edges.set(k, (edges.get(k) ?? 0) + 1); }
  if (pkg === "engine") { console.log("run-time edges between groups (folders as one, root files alone):"); for (const [k, v] of [...edges].sort()) console.log(`  ${k} (${v})`); }
  // cycles (run-time), Tarjan
  let idx = 0; const st = [], on = new Set(), ix = new Map(), low = new Map(), sccs = [];
  const strong = (v) => { ix.set(v, idx); low.set(v, idx); idx++; st.push(v); on.add(v); for (const w of graph.get(v) ?? []) { if (!graph.has(w)) continue; if (!ix.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); } else if (on.has(w)) low.set(v, Math.min(low.get(v), ix.get(w))); } if (low.get(v) === ix.get(v)) { const c = []; let w; do { w = st.pop(); on.delete(w); c.push(w); } while (w !== v); if (c.length > 1) sccs.push(c); } };
  for (const v of graph.keys()) if (!ix.has(v)) strong(v);
  console.log(`run-time import cycles: ${sccs.length}`); for (const c of sccs) console.log(`  ${c.join(" <-> ")}`);
}
// manager public methods and WorkflowRunOptions fields
{
  const f = join(repo, "packages/engine/src/workflow-manager.ts");
  const sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true);
  for (const st of sf.statements) if (ts.isClassDeclaration(st)) {
    const pub = [], priv = []; let fields = 0;
    for (const m of st.members) {
      const mods = (ts.getModifiers(m) ?? []).map((x) => x.kind);
      const isPrivate = mods.includes(ts.SyntaxKind.PrivateKeyword) || mods.includes(ts.SyntaxKind.ProtectedKeyword) || (m.name && ts.isPrivateIdentifier(m.name));
      if (ts.isMethodDeclaration(m) || ts.isGetAccessor(m)) (isPrivate ? priv : pub).push(m.name.getText(sf)); else if (ts.isPropertyDeclaration(m)) fields++;
    }
    console.log(`\nclass ${st.name?.text}: public methods ${pub.length} (${pub.join(", ")}), private methods ${priv.length}, fields ${fields}`);
  }
  const g = join(repo, "packages/engine/src/workflow.ts");
  const sg = ts.createSourceFile(g, readFileSync(g, "utf8"), ts.ScriptTarget.Latest, true);
  const visit = (n) => { if ((ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) && /Options$/.test(n.name.text)) { const members = ts.isInterfaceDeclaration(n) ? n.members : ts.isTypeLiteralNode(n.type) ? n.type.members : undefined; if (members) console.log(`${n.name.text}: ${members.length} fields`); } ts.forEachChild(n, visit); };
  visit(sg);
  // longest functions
  for (const [label, file] of [["workflow.ts", g], ["workflow-manager.ts", f]]) {
    const s = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const fns = [];
    const v = (n) => { if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) { const a = s.getLineAndCharacterOfPosition(n.getStart(s)).line + 1, b = s.getLineAndCharacterOfPosition(n.getEnd()).line + 1; const name = n.name?.getText(s) ?? (n.parent && ts.isVariableDeclaration(n.parent) ? n.parent.name.getText(s) : n.parent && ts.isPropertyAssignment(n.parent) ? n.parent.name.getText(s) : "(anonymous)"); fns.push({ name, a, len: b - a + 1 }); } ts.forEachChild(n, v); };
    v(s);
    console.log(`${label} longest functions: ${fns.sort((x, y) => y.len - x.len).slice(0, 6).map((x) => `${x.name}@${x.a} ${x.len}`).join(", ")}`);
  }
}
