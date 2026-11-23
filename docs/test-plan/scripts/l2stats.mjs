// Totals of a second-layer mutant file: node l2stats.mjs <layer2.jsonl>
import { readFileSync } from "node:fs";
const rows = readFileSync(process.argv[2], "utf8").trim().split("\n").map(JSON.parse);
const comp = rows.filter((r) => r.build === "ok");
const c = (f) => comp.filter(f).length;
const any = (r) => r.own === "fail" || r.orc === "fail" || r.baseline === "fail";
console.log(`rows ${rows.length}, build fails ${rows.length - comp.length}, compile ${comp.length}`);
console.log(`own ${c((r) => r.own === "fail")}, orc ${c((r) => r.orc === "fail")}, baseline ${c((r) => r.baseline === "fail")}, any ${c(any)}, none ${c((r) => !any(r))}`);
for (const r of comp.filter((r) => !any(r))) console.log("  survives", r.file + ":" + r.line, r.op);
for (const r of comp.filter((r) => r.baseline === "fail" && r.orc !== "fail" && r.own !== "fail")) console.log("  baseline only", r.file + ":" + r.line, r.op);
