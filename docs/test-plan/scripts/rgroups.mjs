import { readFileSync, writeFileSync } from "node:fs";
const files = process.argv.slice(2);
const seen = new Set(); const rows = [];
for (const f of files) for (const line of readFileSync(f, "utf8").split("\n").slice(1)) {
  const c = line.split("\t"); if (c.length < 8 || c[4].trim() !== "R") continue;
  const key = c[0] + "::" + c[3]; if (seen.has(key)) continue; seen.add(key);
  rows.push({ file: c[0].replace("packages/engine/test/", ""), start: c[1], name: c[3], saved: +c[5] || 0, reason: c[7], src: f.split("/").pop().split("-")[0] });
}
const groups = [
  ["paused-reuse", /reuses? (of )?a (run )?paused|paused run as a new run|paused or dead run as a new run|reuse a paused|paused at the (usage )?limit, which orc refuses|rerun --reuse|unreachable path as L139|resume of a stopped run under its own/i],
  ["old-saves", /older code|old (save|project|event|data|run|dead)|legacy|0\.23|b21cd2c4|budgetDebit|retired error codes|\.agentprism|inputs ?format 1|inputsFormat 1|no call rows|journalResume|index-hash|path-hash|\.lineage|\.script\.js|Reader for|unmarked|no mark|executionMode|no event stream|answer policies|origin headless|Hand-made from/i],
  ["refused", /removed (option|feature)|is refused|Refusal of|refuse.*(tier|budget|headless)|Pi and OpenCode/i],
  ["inert", /meta\.backends|promptMeta|resume: \{ filesystem \}|resumeSafety|no code reads|read by no|reads them for a decision|nothing reads/i],
  ["library-only", /.*/],
];
const out = new Map(groups.map(([g]) => [g, { n: 0, lines: 0, files: new Map(), rows: [] }]));
for (const r of rows) { const g = groups.find(([, re]) => re.test(r.reason))[0]; const e = out.get(g); e.n++; e.lines += r.saved; e.files.set(r.file, (e.files.get(r.file) ?? 0) + r.saved); e.rows.push(r); r.group = g; }
for (const [g, e] of out) { console.log(`\n## ${g}: ${e.n} rows, ${e.lines} lines`); console.log([...e.files].sort((a, b) => b[1] - a[1]).map(([f, l]) => `${f} ${l}`).join("; ")); if (process.env.SHOW === g) for (const r of e.rows) console.log("   ", r.file + ":" + r.start, r.saved, "|", r.reason.slice(0, 150)); }
writeFileSync("review/r-rows.json", JSON.stringify(rows, null, 1));
