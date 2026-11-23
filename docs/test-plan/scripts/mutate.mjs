// Hand-made mutation sampling.
//   node mutate.mjs gen <repo> <package> <count> <seed> <out.json>
//   node mutate.mjs run <mutants.json> <per-test-cov.jsonl> <out.jsonl> <worker dir>...
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const [cmd, ...rest] = process.argv.slice(2);

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

if (cmd === "gen") {
  const [repoArg, pkg, countArg, seedArg, out] = rest;
  const repo = resolve(repoArg);
  const ts = createRequire(join(repo, "package.json"))("typescript");
  const src = join(repo, "packages", pkg, "src");
  const walk = (d, o = []) => { for (const n of readdirSync(d)) { const p = join(d, n); if (n === "generated") continue; if (statSync(p).isDirectory()) walk(p, o); else if (n.endsWith(".ts")) o.push(p); } return o; };
  const K = ts.SyntaxKind;
  const swap = new Map([[K.EqualsEqualsEqualsToken, "!=="], [K.ExclamationEqualsEqualsToken, "==="], [K.AmpersandAmpersandToken, "||"], [K.BarBarToken, "&&"], [K.LessThanToken, "<="], [K.LessThanEqualsToken, "<"], [K.GreaterThanToken, ">="], [K.GreaterThanEqualsToken, ">"]]);
  const all = [];
  for (const file of walk(src)) {
    const name = relative(join(repo, "packages", pkg), file);
    if (/^src\/(index|testing)\.ts$/.test(name)) continue;
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const line = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
    const add = (op, start, end, repl) => all.push({ pkg, file: name, op, start, end, repl, line: line(start), endLine: line(end), was: text.slice(start, end).slice(0, 80) });
    const visit = (node) => {
      if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
      if (ts.isIfStatement(node)) add("negate-if", node.expression.getStart(sf), node.expression.getEnd(), `!(${node.expression.getText(sf)})`);
      else if (ts.isConditionalExpression(node)) add("negate-ternary", node.condition.getStart(sf), node.condition.getEnd(), `!(${node.condition.getText(sf)})`);
      else if (ts.isBinaryExpression(node) && swap.has(node.operatorToken.kind)) add("swap-operator", node.operatorToken.getStart(sf), node.operatorToken.getEnd(), swap.get(node.operatorToken.kind));
      else if ((node.kind === K.TrueKeyword || node.kind === K.FalseKeyword)) add("flip-boolean", node.getStart(sf), node.getEnd(), node.kind === K.TrueKeyword ? "false" : "true");
      else if (ts.isExpressionStatement(node)) {
        let e = node.expression; if (ts.isAwaitExpression(e)) e = e.expression;
        if (ts.isCallExpression(e) && e.expression.kind !== K.SuperKeyword) add("drop-call", node.getStart(sf), node.getEnd(), "void 0;");
      } else if (ts.isReturnStatement(node) && node.expression && node.expression.getText(sf) !== "undefined") add("return-undefined", node.expression.getStart(sf), node.expression.getEnd(), "undefined");
      else if (ts.isPrefixUnaryExpression(node) && node.operator === K.ExclamationToken) add("drop-not", node.getStart(sf), node.getStart(sf) + 1, "");
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  const rand = rng(Number(seedArg));
  const byFile = new Map();
  for (const m of all) { if (!byFile.has(m.file)) byFile.set(m.file, []); byFile.get(m.file).push(m); }
  const count = Number(countArg);
  const picked = [];
  for (const [, list] of byFile) {
    const want = Math.max(1, Math.round(count * list.length / all.length));
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    picked.push(...list.slice(0, want));
  }
  picked.forEach((m, i) => { m.id = `${pkg}-${i}`; });
  writeFileSync(out, JSON.stringify(picked, null, 1));
  const ops = {}; for (const m of picked) ops[m.op] = (ops[m.op] ?? 0) + 1;
  console.log(`candidates ${all.length}, picked ${picked.length}, files ${byFile.size}`, ops);
}

if (cmd === "run") {
  const [mutantsPath, covPath, outPath, ...workers] = rest;
  const mutants = JSON.parse(readFileSync(mutantsPath, "utf8"));
  { const rand = rng(11); for (let i = mutants.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [mutants[i], mutants[j]] = [mutants[j], mutants[i]]; } }
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tests = readFileSync(covPath, "utf8").trim().split("\n").map(JSON.parse);
  const done = new Set(existsSync(outPath) ? readFileSync(outPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).id) : []);
  const reporter = resolve(new URL("./list-reporter.mjs", import.meta.url).pathname);
  // file -> line -> set of test indexes
  const index = new Map();
  tests.forEach((t, i) => { for (const [f, c] of Object.entries(t.cov)) { if (!index.has(f)) index.set(f, new Map()); const m = index.get(f); for (const l of c.l) { if (!m.has(l)) m.set(l, []); m.get(l).push(i); } } });
  let next = 0, finished = 0;
  async function work(dir) {
    const pkgDir = (m) => join(resolve(dir), "packages", m.pkg);
    while (next < mutants.length) {
      const m = mutants[next++];
      if (done.has(m.id)) continue;
      const lines = index.get(m.file) ?? new Map();
      const covering = new Set();
      for (let l = m.line; l <= m.endLine; l++) for (const i of lines.get(l) ?? []) covering.add(i);
      const files = [...new Set([...covering].map((i) => tests[i].file))];
      const result = { id: m.id, file: m.file, line: m.line, op: m.op, was: m.was, repl: m.repl.slice(0, 80), coveringTests: covering.size, coveringFiles: files.length };
      if (!files.length) { appendFileSync(outPath, JSON.stringify({ ...result, status: "uncovered" }) + "\n"); finished++; continue; }
      const path = join(pkgDir(m), m.file);
      const original = readFileSync(path, "utf8");
      writeFileSync(path, original.slice(0, m.start) + m.repl + original.slice(m.end));
      const scratch = mkdtempSync(join(tmpdir(), "mut-"));
      const env = { ...process.env, HOME: join(scratch, "home"), CLAUDE_CONFIG_DIR: join(scratch, "claude"), CODEX_HOME: join(scratch, "codex") };
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      const started = Date.now();
      let outText = "";
      const outcome = await new Promise((res) => {
        const c = spawn(join(resolve(dir), "node_modules/.bin/tsx"), ["--test", "--test-concurrency=4", `--test-reporter=${reporter}`, "--test-reporter-destination=stdout", ...[...new Set([...covering].map((i) => tests[i].name))].map((n) => `--test-name-pattern=^${esc(n)}$`), ...files], { cwd: pkgDir(m), env, stdio: ["ignore", "pipe", "ignore"], detached: true });
        let fails = 0, seen = 0;
        c.stdout.on("data", (d) => { outText += d; const text = String(d); fails += (text.match(/\{"ok":false,[^\n]*"type":"test"/g) ?? []).length; seen += (text.match(/\{"ok":/g) ?? []).length; if (fails >= 12) { try { process.kill(-c.pid, "SIGKILL"); } catch {} res("early"); } });
        const timer = setTimeout(() => { try { process.kill(-c.pid, "SIGKILL"); } catch {} res("timeout"); }, 150_000);
        c.on("exit", (code) => { clearTimeout(timer); res(code); });
      });
      writeFileSync(path, original);
      rmSync(scratch, { recursive: true, force: true });
      const failed = [];
      for (const l of outText.split("\n")) { if (!l.startsWith("{")) continue; try { const r = JSON.parse(l); if (!r.ok && r.type !== "suite") failed.push(`${relative(pkgDir(m), r.file ?? "")}::${r.name}`); } catch {} }
      const status = failed.length ? "killed" : outcome === "timeout" ? "timeout" : outcome !== 0 ? "killed" : "survived";
      appendFileSync(outPath, JSON.stringify({ ...result, status, exit: outcome, wall: Date.now() - started, failed }) + "\n");
      finished++;
      if (finished % 20 === 0) console.log(`${finished}/${mutants.length}`);
    }
  }
  await Promise.all(workers.map(work));
  console.log("done");
}
