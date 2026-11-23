// What the cut list costs. Usage:
//   node aftercut.mjs <per-test.jsonl> <mutation.jsonl> [--with-R] <review.tsv>...
// Reads every review TSV (file start end name code lines covered_by reason).
// Prints lines saved per code and per file, coverage lost, and mutants no remaining test catches.
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const withR = args.includes("--with-R");
const [perTestPath, mutationPath, ...tsvs] = args.filter((a) => a !== "--with-R");
const rows = [];
for (const path of tsvs) {
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  for (const line of lines.slice(1)) {
    const [file, start, end, name, code, saved, coveredBy, reason] = line.split("\t");
    if (!file || !code) continue;
    rows.push({ file: file.replace(/^packages\/[a-z]+\//, ""), pkg: file.split("/")[1], full: file, start: +start, end: +end, name, code: code.trim(), saved: +saved || 0, coveredBy, reason, src: path.split("/").pop() });
  }
}
// The same test in two review files: keep the first row, and print the pair when the codes differ.
{
  const seen = new Map();
  for (let i = 0; i < rows.length; i++) {
    const key = `${rows[i].full}::${rows[i].name}`;
    const first = seen.get(key);
    if (first === undefined) { seen.set(key, i); continue; }
    if (rows[first].code !== rows[i].code) console.log(`two verdicts: ${rows[first].code} (${rows[first].src}) and ${rows[i].code} (${rows[i].src}) for ${key.slice(0, 150)}`);
    rows.splice(i--, 1);
  }
}
const byCode = new Map();
for (const r of rows) { const e = byCode.get(r.code) ?? { n: 0, lines: 0 }; e.n++; e.lines += r.saved; byCode.set(r.code, e); }
console.log("rows", rows.length);
for (const [c, e] of [...byCode].sort()) console.log(`  ${c.padEnd(4)} tests ${String(e.n).padStart(4)}  lines ${String(e.lines).padStart(6)}`);
const byFile = new Map();
for (const r of rows) { const e = byFile.get(r.full) ?? { n: 0, lines: 0, R: 0, rLines: 0 }; if (r.code === "R") { e.R++; e.rLines += r.saved; } else { e.n++; e.lines += r.saved; } byFile.set(r.full, e); }
console.log("\nper file: tests, lines (without R) | R tests, R lines");
for (const [f, e] of [...byFile].sort((a, b) => b[1].lines + b[1].rLines - a[1].lines - a[1].rLines)) console.log(`  ${String(e.n).padStart(3)} ${String(e.lines).padStart(5)} | ${String(e.R).padStart(3)} ${String(e.rLines).padStart(5)}  ${f}`);

// The tests that go: every code but M and S-kept. M keeps every case. R goes only with --with-R.
const goes = (r) => r.code !== "M" && r.code !== "S" && (r.code !== "R" || withR) && !/^keep/i.test(r.reason ?? "");
const cut = new Set(rows.filter((r) => r.pkg === "engine" && goes(r)).map((r) => `${r.file}::${r.name}`));
const per = readFileSync(perTestPath, "utf8").trim().split("\n").map(JSON.parse);
const known = new Set(per.map((r) => `${r.file}::${r.name}`));
const unknown = [...cut].filter((k) => !known.has(k));
console.log(`\nengine tests cut: ${cut.size} (${withR ? "with" : "without"} R); names not found in the coverage data: ${unknown.length}`);
for (const u of unknown.slice(0, 15)) console.log("   ?", u.slice(0, 150));
const keys = (r) => { const k = []; for (const [f, c] of Object.entries(r.cov)) { for (const l of c.l) k.push(`${f}:L${l}`); for (const b of c.b) k.push(`${f}:B${b}`); } return k; };
const before = new Set(), after = new Set();
for (const r of per) { const isCut = cut.has(`${r.file}::${r.name}`); for (const k of keys(r)) { before.add(k); if (!isCut) after.add(k); } }
const lost = [...before].filter((k) => !after.has(k));
const lostLines = lost.filter((k) => k.includes(":L"));
console.log(`coverage keys before ${before.size}, after ${after.size}; lost lines ${lostLines.length}, lost branches ${lost.length - lostLines.length}`);
const lostBy = new Map();
for (const k of lostLines) { const [f, l] = k.split(":L"); if (!lostBy.has(f)) lostBy.set(f, []); lostBy.get(f).push(+l); }
for (const [f, ls] of lostBy) console.log(`   ${f}: ${ls.sort((a, b) => a - b).join(",").slice(0, 200)}`);
// who was the only cover of each lost line
const blame = new Map();
for (const r of per) { const id = `${r.file}::${r.name}`; if (!cut.has(id)) continue; for (const k of keys(r)) if (!after.has(k) && k.includes(":L")) blame.set(id, (blame.get(id) ?? 0) + 1); }
for (const [id, n] of [...blame].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`   ${String(n).padStart(4)} lines only under: ${id.slice(0, 140)}`);

const muts = readFileSync(mutationPath, "utf8").trim().split("\n").map(JSON.parse);
const killed = muts.filter((m) => (m.failed ?? []).length > 0);
let orphan = 0, weak = 0;
const orphans = [];
for (const m of killed) {
  const left = m.failed.filter((t) => !cut.has(t));
  if (left.length === 0) { orphan++; orphans.push(m); } else if (left.length === 1) weak++;
}
console.log(`\nmutants run ${muts.length}; caught ${killed.length}; caught only by cut tests ${orphan}; caught by one remaining test ${weak}`);
for (const m of orphans) console.log(`   ${m.id} ${m.file}:${m.line} ${m.op} status=${m.status} failed=${m.failed.length}: ${m.failed.slice(0, 3).join(" | ").slice(0, 260)}`);
