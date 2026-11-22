// The architecture, as a test.
//
// It runs none of the app. It reads the source and checks the packages, what each file imports,
// and where a few ideas live, against the tables below. The tables are the architecture. Change
// them in a commit of their own, and never to turn a red test green. When a rule fails, move the
// code to the place that owns it.
//
// Each rule starts with the places that break it today, in BREAKS. That list can only shrink. The
// test fails when a new break appears, and when a listed break is already gone, so the list stays
// true. The refactor is done when every list is empty.
//
// ARCH_PRINT=1 node --test test/architecture.test.mjs prints the breaks found now.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(import.meta.url)("typescript");

// ── The tables ──────────────────────────────────────────────────────────────────────────────────

/** Our npm scope. The fork's scope, @automatalabs, must be gone. */
const SCOPE = "@orchestrator";

/** The only packages. orc is the command line, engine the backend, harnesses the programs. */
const PACKAGES = ["orc", "engine", "harnesses"];

/** Old folder names of the table's packages, while the refactor moves them. Empty at the end. */
const OLD_NAMES = {};

/**
 * What each package may import besides node's own modules and its own files. Ours are named
 * without the scope. orc imports only the engine, the engine reaches the programs only through
 * the harnesses' public entry, and the harnesses import nothing of ours.
 */
const MAY_IMPORT = {
  orc: { ours: ["engine"], outside: [] },
  engine: { ours: ["harnesses"], outside: ["typebox", "acorn", "yaml", "smol-toml"] },
  harnesses: { ours: [], outside: ["@anthropic-ai/claude-agent-sdk", "typebox", "yaml", "smol-toml"] },
};

/** No file of any package imports these. */
const NEVER_IMPORT = ["@agentclientprotocol/", "@zed-industries/", "@automatalabs/", "@openai/codex-sdk", "@openai/codex"];

/** One folder per harness adapter in packages/harnesses/src. An adapter never imports another. */
const HARNESSES = ["claude", "codex"];

/** The tests every adapter passes against a fake program. It names each adapter. */
const CONTRACT_TEST = "packages/harnesses/test/contract.test.ts";

/**
 * One home per idea. A source file outside the home that matches the pattern is a break.
 * Tests are not checked.
 */
const HOMES = [
  {
    idea: "run files: the record, its log, its questions, its snapshot, its events and the agent cap",
    pattern: /\bpaths\.(records|inbox|logs|slots|queue)\b|["'`](records|inbox|logs|slots|queue)["'`]|\.events\.jsonl|\.lineage\b|\bruns[Dd]ir\b/,
    home: ["packages/engine/src/runs/"],
  },
  {
    idea: "making a git worktree",
    pattern: /["'`]worktree["'`]\s*,\s*["'`]add["'`]|worktree add/,
    home: ["packages/engine/src/places/"],
  },
  {
    // An account becomes these variables inside its program's adapter, and only there.
    idea: "naming a program's login or folder variable",
    pattern: /\b(CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CONFIG_DIR|CODEX_HOME)\b/,
    home: ["packages/harnesses/src/claude/", "packages/harnesses/src/codex/"],
  },
  {
    idea: "starting codex",
    pattern: /app-server/,
    home: ["packages/harnesses/src/codex/"],
  },
  {
    idea: "importing the Claude Agent SDK",
    pattern: /from\s+["'`]@anthropic-ai\/claude-agent-sdk|import\(\s*["'`]@anthropic-ai\/claude-agent-sdk/,
    home: ["packages/harnesses/src/claude/"],
  },
];

/** The engine exports only what orc calls, and the harnesses only what the engine calls. */
const CALLERS = { engine: "orc", harnesses: "engine" };

// ── The breaks of today. They can only go. ──────────────────────────────────────────────────────

const BREAKS = {
  packages: [],
  imports: [],
  homes: [],
  exports: {
    "engine exports names orc never imports": 262
  },
  contract: []
};

// ── Reading the source ──────────────────────────────────────────────────────────────────────────

const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const SKIP = new Set(["node_modules", "dist", "generated", "build", "coverage"]);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (SOURCE.test(name) && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

const rel = (path) => relative(ROOT, path).split(sep).join("/");

function packageDirs() {
  return readdirSync(join(ROOT, "packages")).filter((name) => existsSync(join(ROOT, "packages", name, "package.json")));
}

/** The table name of a package folder, or undefined for a package that must go. */
function role(dir) {
  if (PACKAGES.includes(dir)) return dir;
  return OLD_NAMES[dir];
}

/** Imports of one file: the specifier and the names it takes, read from the parsed file. */
function importsOf(file) {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const names = [];
      let star = false;
      const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
      if (clause?.name) names.push("default");
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const el of bindings.elements) names.push((el.propertyName ?? el.name).text);
      if (bindings && ts.isNamespaceImport(bindings)) star = true;
      if (ts.isExportDeclaration(node)) {
        if (node.exportClause && ts.isNamedExports(node.exportClause)) for (const el of node.exportClause.elements) names.push((el.propertyName ?? el.name).text);
        else star = true;
      }
      found.push({ spec: node.moduleSpecifier.text, names, star });
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) {
        found.push({ spec: node.arguments[0].text, names: [], star: true });
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      found.push({ spec: node.moduleReference.expression.text, names: [], star: true });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const BUILTIN = new Set(builtinModules);

/** The npm package of a specifier: "@a/b/c" is "@a/b", "x/y" is "x". */
function npmName(spec) {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Our package a specifier names, without the scope, or undefined. */
function oursName(spec) {
  const match = /^@(orchestrator|automatalabs)\/([^/]+)/.exec(spec);
  if (!match) return undefined;
  const name = match[2];
  if (name === "workflow-engine") return "engine";
  if (name === "orc") return "orc";
  return name;
}

function collect() {
  const dirs = packageDirs();
  const files = [];
  for (const dir of dirs) {
    for (const file of walk(join(ROOT, "packages", dir, "src"))) files.push({ dir, role: role(dir), file, path: rel(file) });
  }
  return { dirs, files };
}

// ── The rules ───────────────────────────────────────────────────────────────────────────────────

function packageBreaks({ dirs }) {
  const found = [];
  for (const dir of dirs) if (!PACKAGES.includes(dir)) found.push(OLD_NAMES[dir] ? `${dir} is still named for ${OLD_NAMES[dir]}` : `${dir} must go`);
  for (const name of PACKAGES) if (!dirs.includes(name)) found.push(`${name} is missing`);
  for (const dir of dirs) {
    const pkg = JSON.parse(readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8"));
    if (role(dir) && pkg.name !== `${SCOPE}/${role(dir)}`) found.push(`${dir} is published as ${pkg.name}`);
  }
  return found;
}

function importBreaks({ files, dirs }) {
  const found = new Set();
  for (const { dir, role: name, file, path } of files) {
    for (const { spec } of importsOf(file)) {
      for (const never of NEVER_IMPORT) {
        if (spec === never || spec.startsWith(never.endsWith("/") ? never : `${never}/`)) found.add(`${dir} imports ${never.endsWith("/") ? `${never}*` : never}`);
      }
      if (!name) continue;
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec);
        const own = join(ROOT, "packages", dir);
        if (!target.startsWith(own + sep)) found.add(`${path} reaches outside its package with ${spec}`);
        if (name === "harnesses") {
          const from = /^packages\/harnesses\/src\/([^/]+)\//.exec(path)?.[1];
          const to = /^packages\/harnesses\/src\/([^/]+)\//.exec(rel(target))?.[1];
          if (from && to && from !== to && HARNESSES.includes(from) && HARNESSES.includes(to)) found.add(`${path} is the ${from} adapter and imports the ${to} adapter`);
        }
        continue;
      }
      if (spec.startsWith("node:") || BUILTIN.has(npmName(spec))) continue;
      const ours = oursName(spec);
      if (ours) {
        if (ours === name) continue;
        if (!MAY_IMPORT[name].ours.includes(ours)) found.add(`${name} imports ${ours}`);
        else if (spec.split("/").length > 2) found.add(`${name} imports ${spec}, past the public entry`);
        continue;
      }
      if (!MAY_IMPORT[name].outside.includes(npmName(spec))) found.add(`${name} imports ${npmName(spec)}`);
    }
  }
  for (const dir of dirs) {
    const name = role(dir);
    if (!name) continue;
    const pkg = JSON.parse(readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8"));
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      const ours = oursName(dep);
      const allowed = ours ? ours === name || MAY_IMPORT[name].ours.includes(ours) : MAY_IMPORT[name].outside.includes(dep);
      if (!allowed) found.add(`${name} depends on ${ours ?? dep}`);
    }
  }
  return [...found].sort();
}

function homeBreaks({ files }) {
  const found = new Set();
  for (const { dir, role: name, file, path } of files) {
    const text = readFileSync(file, "utf8");
    for (const { idea, pattern, home } of HOMES) {
      if (!pattern.test(text)) continue;
      if (home.some((place) => (place.endsWith("/") ? path.startsWith(place) : path === place))) continue;
      found.add(name ? `${idea}, in ${path}` : `${idea}, in packages/${dir}`);
    }
  }
  return [...found].sort();
}

/** Each exported name of a package's public entry, read by the type checker. */
function exportedNames(dir) {
  const entry = join(ROOT, "packages", dir, "src", "index.ts");
  if (!existsSync(entry)) return [];
  const program = ts.createProgram([entry], { allowJs: false, noEmit: true, skipLibCheck: true, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022 });
  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(program.getSourceFile(entry));
  return symbol ? checker.getExportsOfModule(symbol).map((s) => s.getName()).sort() : [];
}

function exportBreaks({ files, dirs }) {
  const found = {};
  for (const [pkg, caller] of Object.entries(CALLERS)) {
    const dir = dirs.find((d) => role(d) === pkg);
    if (!dir) continue;
    const used = new Set();
    let star = false;
    for (const f of files) {
      if (f.role !== caller) continue;
      for (const { spec, names, star: all } of importsOf(f.file)) {
        if (oursName(spec) !== pkg) continue;
        names.forEach((n) => used.add(n));
        star ||= all;
      }
    }
    const unused = star ? [] : exportedNames(dir).filter((n) => !used.has(n));
    if (star) found[`${caller} imports all of ${pkg} at once`] = 1;
    if (unused.length) found[`${pkg} exports names ${caller} never imports`] = unused.length;
  }
  return found;
}

function contractBreaks() {
  const found = [];
  const src = join(ROOT, "packages", "harnesses", "src");
  const adapters = existsSync(src) ? readdirSync(src).filter((n) => statSync(join(src, n)).isDirectory()) : [];
  for (const name of HARNESSES) if (!adapters.includes(name)) found.push(`the ${name} adapter is missing`);
  for (const name of adapters) if (!HARNESSES.includes(name) && name !== "shared") found.push(`${name} is an adapter the table doesn't list`);
  const contract = join(ROOT, CONTRACT_TEST);
  if (!existsSync(contract)) found.push(`${CONTRACT_TEST} is missing`);
  else {
    const text = readFileSync(contract, "utf8");
    for (const name of HARNESSES) if (!new RegExp(`["'\`]${name}["'\`]`).test(text)) found.push(`the contract test doesn't run the ${name} adapter`);
  }
  return found;
}

// ── The tests ───────────────────────────────────────────────────────────────────────────────────

const state = collect();
const now = {
  packages: packageBreaks(state),
  imports: importBreaks(state),
  homes: homeBreaks(state),
  exports: exportBreaks(state),
  contract: contractBreaks(),
};

if (process.env.ARCH_PRINT) console.log(JSON.stringify(now, null, 2));

/** A listed break that is gone, or a new one, fails with what to change. */
function compareList(rule) {
  const known = new Set(BREAKS[rule]);
  const seen = new Set(now[rule]);
  const added = [...seen].filter((b) => !known.has(b));
  const gone = [...known].filter((b) => !seen.has(b));
  const lines = [];
  if (added.length) lines.push(`New breaks of the ${rule} rule. Move the code to where the tables say:\n  ${added.join("\n  ")}`);
  if (gone.length) lines.push(`Fixed, so remove them from BREAKS.${rule}:\n  ${gone.join("\n  ")}`);
  assert.equal(lines.join("\n"), "", lines.join("\n"));
}

test("only the table's packages exist, under our scope", () => compareList("packages"));
test("each package imports only what the table allows", () => compareList("imports"));
test("each idea lives in its one home", () => compareList("homes"));
test("each package exports only what its caller imports", () => {
  const lines = [];
  for (const key of new Set([...Object.keys(BREAKS.exports), ...Object.keys(now.exports)])) {
    const was = BREAKS.exports[key] ?? 0;
    const is = now.exports[key] ?? 0;
    if (is > was) lines.push(`${key}: ${is}, more than the ${was} listed. Export only what the caller imports.`);
    if (is < was) lines.push(`${key}: ${is}, fewer than the ${was} listed. Lower BREAKS.exports.`);
  }
  assert.equal(lines.join("\n"), "", lines.join("\n"));
});
test("both adapters exist and pass one contract test", () => compareList("contract"));
