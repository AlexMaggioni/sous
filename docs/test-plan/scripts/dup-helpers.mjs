import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
const root = process.argv[2];
const ts = createRequire(join(root, "package.json"))("typescript");
const walk = (d, o = []) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p, o); else if (n.endsWith(".ts")) o.push(p); } return o; };
const byName = new Map();
for (const pkg of ["engine", "orc", "harnesses"]) for (const f of walk(join(root, "packages", pkg, "test"))) {
  const sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true);
  for (const st of sf.statements) {
    let name, node;
    if (ts.isFunctionDeclaration(st) && st.name) { name = st.name.text; node = st; }
    else if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) && ts.isIdentifier(d.name)) { name = d.name.text; node = st; }
    if (!name) continue;
    const lines = sf.getLineAndCharacterOfPosition(node.end).line - sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const body = node.getText(sf).replace(/\s+/g, " ");
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push({ file: relative(root, f), lines, body });
  }
}
let total = 0, same = 0;
const out = [];
for (const [name, defs] of byName) {
  if (defs.length < 2) continue;
  const extra = defs.map((d) => d.lines).sort((a, b) => a - b).slice(0, -1).reduce((a, b) => a + b, 0);
  const identical = new Set(defs.map((d) => d.body)).size;
  total += extra; out.push({ name, n: defs.length, extra, identical });
}
out.sort((a, b) => b.extra - a.extra);
for (const o of out.slice(0, 25)) console.log(String(o.extra).padStart(4), `${o.name} x${o.n}, ${o.identical} distinct bodies`);
console.log("helpers defined in 2+ test files:", out.length, "lines beyond one copy each:", total);
