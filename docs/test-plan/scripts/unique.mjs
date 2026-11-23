// Per-test unique coverage. Usage: node unique.mjs <per-test.jsonl> [--json out]
import { readFileSync, writeFileSync } from "node:fs";
const rows = readFileSync(process.argv[2], "utf8").trim().split("\n").map(JSON.parse);
const count = new Map(); // key -> number of tests covering
const keysOf = (r) => { const k = []; for (const [f, c] of Object.entries(r.cov)) { for (const l of c.l) k.push(`${f}:L${l}`); for (const b of c.b) k.push(`${f}:B${b}`); } return k; };
const sets = rows.map((r) => new Set(keysOf(r)));
for (const s of sets) for (const k of s) count.set(k, (count.get(k) ?? 0) + 1);
// keys covered by tests of the same file only
const fileOf = new Map();
rows.forEach((r, i) => { for (const k of sets[i]) { if (!fileOf.has(k)) fileOf.set(k, new Set()); fileOf.get(k).add(r.file); } });
const out = rows.map((r, i) => {
  let unique = 0, le3 = 0, uniqueLines = 0;
  const uniq = [];
  for (const k of sets[i]) { const c = count.get(k); if (c === 1) { unique++; if (k.includes(":L")) uniqueLines++; uniq.push(k); } if (c <= 3) le3++; }
  return { file: r.file, name: r.name, ms: r.ms, size: sets[i].size, unique, uniqueLines, le3, uniq: uniq.slice(0, 12) };
});
// subset: is test i's set contained in a single other test's set?
for (let i = 0; i < rows.length; i++) {
  if (out[i].unique > 0 || sets[i].size === 0) continue;
  let best = null;
  for (let j = 0; j < rows.length; j++) {
    if (i === j || sets[j].size < sets[i].size) continue;
    let ok = true;
    for (const k of sets[i]) if (!sets[j].has(k)) { ok = false; break; }
    if (ok && (!best || sets[j].size < sets[best].size)) best = j;
  }
  if (best !== null) out[i].subsetOf = `${rows[best].file}::${rows[best].name}`;
}
const jsonAt = process.argv.indexOf("--json");
if (jsonAt > 0) writeFileSync(process.argv[jsonAt + 1], JSON.stringify(out));
const total = out.length, zero = out.filter((o) => o.unique === 0).length, sub = out.filter((o) => o.subsetOf).length;
console.log(`tests ${total}; with no unique line or branch ${zero}; of those, covered whole by one other test ${sub}`);
const byFile = new Map();
for (const o of out) { const e = byFile.get(o.file) ?? { n: 0, zero: 0, sub: 0, unique: 0 }; e.n++; if (o.unique === 0) e.zero++; if (o.subsetOf) e.sub++; e.unique += o.unique; byFile.set(o.file, e); }
// file-level unique: keys covered only by this file
const fileUnique = new Map();
for (const [k, fs] of fileOf) if (fs.size === 1) { const f = [...fs][0]; fileUnique.set(f, (fileUnique.get(f) ?? 0) + 1); }
console.log("\ntests zeroUnique subset fileUniqueKeys file");
for (const [f, e] of [...byFile].sort((a, b) => (fileUnique.get(a[0]) ?? 0) - (fileUnique.get(b[0]) ?? 0))) console.log(String(e.n).padStart(4), String(e.zero).padStart(4), String(e.sub).padStart(4), String(fileUnique.get(f) ?? 0).padStart(6), f);
