// Functions longer than N lines, per package. node funcs.mjs <repo> [N]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
const root = process.argv[2], N = +(process.argv[3] ?? 100);
const ts = createRequire(join(root, "package.json"))("typescript");
const walk = (d, o = []) => { for (const n of readdirSync(d)) { if (["node_modules", "dist", "generated"].includes(n)) continue; const p = join(d, n); if (statSync(p).isDirectory()) walk(p, o); else if (n.endsWith(".ts") && !n.endsWith(".d.ts")) o.push(p); } return o; };
const out = [];
for (const pkg of ["orc", "engine", "harnesses"]) for (const f of walk(join(root, "packages", pkg, "src"))) {
  const sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true);
  const visit = (n) => {
    if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isConstructorDeclaration(n)) {
      const a = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line, b = sf.getLineAndCharacterOfPosition(n.end).line;
      const name = n.name?.getText(sf) ?? (ts.isVariableDeclaration(n.parent) ? n.parent.name.getText(sf) : ts.isPropertyAssignment(n.parent) ? n.parent.name.getText(sf) : "(anonymous)");
      if (b - a + 1 > N) out.push({ file: relative(root, f), name, line: a + 1, len: b - a + 1 });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
out.sort((x, y) => y.len - x.len);
for (const o of out) console.log(String(o.len).padStart(5), `${o.file}:${o.line}`, o.name);
console.log("count", out.length);
