#!/usr/bin/env node
// Renames orc and orchestrator to sous across the repository. Run it from the repository root on a
// clean tree, then run pnpm install --frozen-lockfile, pnpm build and BASELINE_UPDATE=1 for the
// baseline. It moves folders with git mv and rewrites text in every tracked file but the skipped ones.
// `--check` changes nothing and prints each old name that is left.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" });

const MOVES = [
  ["packages/orc", "packages/cli"],
  ["packages/cli/test/orc.ts", "packages/cli/test/sous.ts"],
  ["examples/textkit/.orchestrator", "examples/textkit/.sous"],
  ["docs/orchestrator.md", "docs/guide.md"],
  ["packages/engine/src/orchestrator-globals.ts", "packages/engine/src/sous-globals.ts"],
  ["packages/engine/test/orchestrator-globals.test.ts", "packages/engine/test/sous-globals.test.ts"],
];

// Records of past runs keep the names they ran with. The legal files and the changelog are
// written by hand. The architecture test changes in a commit of its own.
const SKIP = [
  /^docs\/proof\//,
  /^docs\/history\//,
  /^docs\/refactor-plan\.md$/,
  /CHANGELOG\.md$/,
  /^NOTICE$/,
  /^LICENSE$/,
  /^packages\/harnesses\/src\/codex\/generated\//,
  /^scripts\/rename-to-sous\.mjs$/,
  /^test\/architecture\.test\.mjs$/,
];

const RULES = [
  [/@orchestrator\/orc\b/g, "@sous/cli"],
  [/@orchestrator\//g, "@sous/"],
  [/github\.com\/AlexMaggioni\/orchestrator\b/g, "github.com/AlexMaggioni/sous"],
  [/packages\/orc\b/g, "packages/cli"],
  [/"packages", "orc"/g, '"packages", "cli"'],
  [/\bORCHESTRATOR_/g, "SOUS_"],
  [/\bORC_/g, "SOUS_"],
  [/\bORC\b/g, "SOUS"],
  [/\borchestrator\.md\b/g, "guide.md"],
  [/\borchestrator-globals\b/g, "sous-globals"],
  [/Orchestrator(?=[A-Z])/g, "Sous"],
  [/\borchestrator(?=[A-Z])/g, "sous"],
  [/(?<![\w)\]])\.orchestrator\b/g, ".sous"],
  [/\bthe orchestrator repo\b/g, "the sous repo"],
  [/(["'`])orchestrator-(?=[a-z])/g, "$1sous-"],
  [/"name": "orchestrator"/g, '"name": "sous"'],
  [/\b([Aa])n orc\b/g, "$1 sous"],
  [/\borc(?=[A-Z])/g, "sous"],
  [/\borc\b/g, "sous"],
  // \b sees no boundary between the n of an escape such as \n and the word after it.
  [/(?<=\\[nrt])orc\b/g, "sous"],
  [/__orc(?=_)/g, "__sous"],
];

function tracked() {
  const out = [];
  for (const line of git("ls-files", "-s", "-z").split("\0")) {
    if (!line) continue;
    const [meta, path] = line.split("\t");
    if (meta.startsWith("120000") || meta.startsWith("160000")) continue;
    if (SKIP.some((re) => re.test(path))) continue;
    out.push(path);
  }
  return out;
}

function rewrite(text) {
  let next = text;
  for (const [re, to] of RULES) next = next.replace(re, to);
  return next;
}

const check = process.argv.includes("--check");
if (check) {
  const OLD = /\bORC_|ORCHESTRATOR|[Oo]rchestrator|(?:\b|(?<=\\[nrt]))orc(?:\b|(?=[A-Z_]))|__orc/;
  let left = 0;
  for (const path of tracked()) {
    if (!existsSync(path)) continue;
    readFileSync(path, "utf8").split("\n").forEach((line, i) => {
      if (OLD.test(line)) {
        left++;
        console.log(`${path}:${i + 1}: ${line.trim().slice(0, 140)}`);
      }
    });
  }
  console.log(`${left} lines with an old name`);
  process.exit(left ? 1 : 0);
}

for (const [from, to] of MOVES) if (existsSync(from)) git("mv", from, to);

let changed = 0;
for (const path of tracked()) {
  if (!existsSync(path)) continue;
  const buffer = readFileSync(path);
  if (buffer.includes(0)) continue;
  const text = buffer.toString("utf8");
  const next = rewrite(text);
  if (next !== text) {
    writeFileSync(path, next);
    changed++;
  }
}
console.log(`moved ${MOVES.length} paths, rewrote ${changed} files`);
