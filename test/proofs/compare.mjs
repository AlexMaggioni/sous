#!/usr/bin/env node
// Compares two folders written by run.mjs, proof by proof, and prints each difference as
// "proof: path: old -> new". Exits 1 if there is any difference, 0 if there is none.
//
// Usage: node test/proofs/compare.mjs <baseline dir> <new dir>
// Lists of objects that each have a unique label, id or name are matched by that key, so a step
// that moved shows as a changed order, not as every later step changed.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const show = (v) => (v === undefined ? "(missing)" : JSON.stringify(v));

function load(dir) {
  if (!existsSync(dir)) {
    process.stderr.write(`${dir} does not exist\n`);
    process.exit(2);
  }
  const proofs = new Map();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "summary.json").sort()) {
    proofs.set(file.replace(/\.json$/, ""), JSON.parse(readFileSync(join(dir, file), "utf8")));
  }
  return proofs;
}

/** The key that names each item of a list, if every item has a distinct one. */
function itemKey(list) {
  if (!list.length || !list.every(isObj)) return undefined;
  for (const key of ["label", "id", "name"]) {
    const values = list.map((item) => item[key]);
    if (values.every((v) => typeof v === "string") && new Set(values).size === values.length) return key;
  }
  return undefined;
}

function diff(a, b, path, out) {
  if (Array.isArray(a) && Array.isArray(b)) {
    const key = itemKey(a) && itemKey(a) === itemKey(b) ? itemKey(a) : undefined;
    if (key) {
      const left = new Map(a.map((item) => [item[key], item]));
      const right = new Map(b.map((item) => [item[key], item]));
      for (const [name, item] of left) {
        if (right.has(name)) diff(item, right.get(name), `${path}[${key}=${name}]`, out);
        else out.push(`${path}: ${key} ${name} is gone`);
      }
      for (const name of right.keys()) if (!left.has(name)) out.push(`${path}: ${key} ${name} is new`);
      const order = (list) => list.map((item) => item[key]).filter((name) => left.has(name) && right.has(name));
      if (order(a).join("\n") !== order(b).join("\n")) out.push(`${path}: order ${show(order(a))} -> ${show(order(b))}`);
      return;
    }
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= a.length) out.push(`${path}[${i}]: (missing) -> ${show(b[i])}`);
      else if (i >= b.length) out.push(`${path}[${i}]: ${show(a[i])} -> (missing)`);
      else diff(a[i], b[i], `${path}[${i}]`, out);
    }
    return;
  }
  if (isObj(a) && isObj(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[key], b[key], path ? `${path}.${key}` : key, out);
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path || "(top)"}: ${show(a)} -> ${show(b)}`);
}

const [oldDir, newDir] = process.argv.slice(2);
if (!oldDir || !newDir) {
  process.stderr.write("usage: node test/proofs/compare.mjs <baseline dir> <new dir>\n");
  process.exit(2);
}
const before = load(oldDir);
const after = load(newDir);
let count = 0;
for (const proof of new Set([...before.keys(), ...after.keys()])) {
  if (!after.has(proof)) {
    process.stdout.write(`${proof}: only in ${oldDir}\n`);
    count++;
    continue;
  }
  if (!before.has(proof)) {
    process.stdout.write(`${proof}: only in ${newDir}\n`);
    count++;
    continue;
  }
  const lines = [];
  diff(before.get(proof), after.get(proof), "", lines);
  for (const line of lines) process.stdout.write(`${proof}: ${line}\n`);
  count += lines.length;
}
process.stdout.write(count ? `${count} difference${count === 1 ? "" : "s"}\n` : "no differences\n");
process.exit(count ? 1 : 0);
