#!/usr/bin/env node
// Writes src/codex/generated/ from `codex app-server generate-ts`. It keeps only the files the
// adapter's imports reach, and heads each one with the Codex version it came from.
//
//   pnpm codex-types [path to codex]
//
// The path defaults to CODEX_PATH, then codex on PATH. Codex runs with a temporary HOME and
// CODEX_HOME, so it reads and writes nothing of the user's.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const adapter = join(root, "src", "codex");
const target = join(adapter, "generated");
const codex = process.argv[2] ?? process.env.CODEX_PATH ?? "codex";

const work = mkdtempSync(join(tmpdir(), "codex-types-"));
const env = { ...process.env, HOME: join(work, "home"), CODEX_HOME: join(work, "codex-home") };
mkdirSync(env.HOME);
mkdirSync(env.CODEX_HOME);

const version = /\d+\.\d+\.\d+\S*/.exec(execFileSync(codex, ["--version"], { env, encoding: "utf8" }))?.[0];
if (!version) throw new Error(`${codex} --version printed no version.`);
const out = join(work, "out");
execFileSync(codex, ["app-server", "generate-ts", "--out", out, "--experimental"], { env, stdio: ["ignore", "ignore", "inherit"] });

/** Relative import paths in a file, such as ../serde_json/JsonValue. */
const importsOf = (text) => [...text.matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)].map((match) => match[1]);

// The adapter's own imports of ./generated/... or ../generated/..., as paths under the output.
const wanted = new Set();
for (const name of readdirSync(adapter)) {
  if (!name.endsWith(".ts")) continue;
  const text = readFileSync(join(adapter, name), "utf8");
  for (const match of text.matchAll(/from\s+"\.\/generated\/([^"]+)\.js"/g)) wanted.add(`${match[1]}.ts`);
}
if (wanted.size === 0) throw new Error("src/codex imports nothing from ./generated, so there is nothing to keep.");

// Every file those imports reach.
const queue = [...wanted];
const kept = new Set();
while (queue.length) {
  const file = queue.shift();
  if (kept.has(file)) continue;
  const source = join(out, file);
  if (!existsSync(source)) throw new Error(`Codex ${version} generated no ${file}. The adapter imports a type this version lacks.`);
  kept.add(file);
  for (const spec of importsOf(readFileSync(source, "utf8"))) {
    queue.push(posix.normalize(posix.join(posix.dirname(file), `${spec}.ts`)));
  }
}

// NodeNext needs .js on relative imports.
const header = `// From codex-cli ${version}, \`codex app-server generate-ts --experimental\`. Run \`pnpm codex-types\` to update.\n`;
const fresh = join(work, "generated");
for (const file of [...kept].sort()) {
  const text = readFileSync(join(out, file), "utf8").replace(/from\s+"(\.{1,2}\/[^"]+)"/g, 'from "$1.js"');
  mkdirSync(dirname(join(fresh, file)), { recursive: true });
  writeFileSync(join(fresh, file), header + text);
}

// The old folder moves to the temporary folder, so a failed run leaves the last good copy.
if (existsSync(target)) renameSync(target, join(work, "previous"));
renameSync(fresh, target);
console.log(`Kept ${kept.size} of the files Codex ${version} generated, in ${relative(process.cwd(), target) || target}.`);
