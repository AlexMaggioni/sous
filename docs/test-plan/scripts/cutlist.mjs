// Writes review/cut-list.tsv from the deduped engine rows, the R groups and the orc and harnesses review.
import { readFileSync, writeFileSync } from "node:fs";
const eng = JSON.parse(readFileSync("review/engine-rows.json", "utf8"));
const rg = new Map(JSON.parse(readFileSync("review/r-rows.json", "utf8")).map((r) => [r.file + "::" + r.name, r.group]));
const rows = eng.map((r) => ({ file: "packages/engine/test/" + r.file, start: r.start, end: r.end ?? "", name: r.name, code: r.code, saved: r.saved, by: r.by ?? "", reason: r.reason ?? "", group: r.code === "R" ? rg.get(r.file + "::" + r.name) ?? "" : "" }));
for (const line of readFileSync("review/g4-orc-harnesses.tsv", "utf8").split("\n").slice(1)) {
  const c = line.split("\t"); if (c.length < 5) continue;
  rows.push({ file: c[0], start: c[1], end: c[2], name: c[3], code: c[4].trim(), saved: +c[5] || 0, by: c[6] ?? "", reason: c[7] ?? "", group: c[4].trim() === "R" ? "old-saves" : "" });
}
const KEEP = new Set(process.argv.slice(2));
const action = (r) => {
  if (KEEP.has(`${r.file}:${r.start}`)) return "keep";
  if (r.code === "M") return "merge";
  if (r.code === "S") return "fix";
  if (r.code === "R") return r.group === "refused" ? "keep" : "owner:" + r.group;
  return "cut";
};
const order = { cut: 0, merge: 1, fix: 2, keep: 4 };
for (const r of rows) r.action = action(r);
rows.sort((a, b) => (order[a.action] ?? 3) - (order[b.action] ?? 3) || a.action.localeCompare(b.action) || a.code.localeCompare(b.code) || a.file.localeCompare(b.file) || +a.start - +b.start);
const clean = (s) => String(s).replace(/[\t\n]/g, " ");
writeFileSync("review/cut-list.tsv", ["action\tcode\tfile\tstart_line\ttest_name\tlines_saved\tcovered_by\treason", ...rows.map((r) => [r.action, r.code, r.file, r.start, r.name, r.saved, r.by, r.reason].map(clean).join("\t"))].join("\n") + "\n");
const tot = new Map();
for (const r of rows) { const pkg = r.file.split("/")[1] ?? "root"; const k = `${pkg} ${r.action} ${r.code}`; const e = tot.get(k) ?? { n: 0, l: 0 }; e.n++; e.l += r.saved; tot.set(k, e); }
for (const [k, e] of [...tot].sort()) console.log(k.padEnd(40), e.n, e.l);
console.log("rows", rows.length);
