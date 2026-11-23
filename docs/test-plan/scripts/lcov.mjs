// Usage: node lcov.mjs summary file.lcov | uncovered file.lcov src/x.ts
import { readFileSync } from "node:fs";
export function parse(path) {
  const files = new Map();
  let cur;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.startsWith("SF:")) { cur = { lines: new Map(), fns: new Map(), br: [] }; files.set(line.slice(3), cur); }
    else if (line.startsWith("DA:")) { const [n, h] = line.slice(3).split(",").map(Number); cur.lines.set(n, h); }
    else if (line.startsWith("FNDA:")) { const i = line.indexOf(","); cur.fns.set(line.slice(i + 1), Number(line.slice(5, i))); }
    else if (line.startsWith("BRDA:")) { const p = line.slice(5).split(","); cur.br.push({ line: Number(p[0]), hit: p[3] === "-" ? 0 : Number(p[3]) }); }
  }
  return files;
}
const [cmd, path, arg] = process.argv.slice(2);
if (cmd === "summary") {
  const files = parse(path);
  let T = 0, H = 0;
  const rows = [];
  for (const [name, f] of files) {
    if (!name.startsWith("src/")) continue;
    const total = f.lines.size, hit = [...f.lines.values()].filter((h) => h > 0).length;
    const fnT = f.fns.size, fnH = [...f.fns.values()].filter((h) => h > 0).length;
    const brT = f.br.length, brH = f.br.filter((b) => b.hit > 0).length;
    T += total; H += hit;
    rows.push({ name, total, miss: total - hit, pct: (100 * hit / total).toFixed(1), fn: `${fnH}/${fnT}`, br: `${brH}/${brT}` });
  }
  rows.sort((a, b) => b.miss - a.miss);
  for (const r of rows) console.log(`${r.name.padEnd(52)} lines ${String(r.total).padStart(5)} miss ${String(r.miss).padStart(4)} ${r.pct.padStart(5)}%  fn ${r.fn.padStart(7)}  br ${r.br}`);
  console.log(`TOTAL lines ${T} hit ${H} ${(100 * H / T).toFixed(2)}%`);
}
if (cmd === "uncovered") {
  const f = parse(path).get(arg);
  const miss = [...f.lines].filter(([, h]) => h === 0).map(([n]) => n).sort((a, b) => a - b);
  const ranges = []; let s = null, p = null;
  for (const n of miss) { if (s === null) { s = p = n; } else if (n === p + 1) p = n; else { ranges.push(s === p ? `${s}` : `${s}-${p}`); s = p = n; } }
  if (s !== null) ranges.push(s === p ? `${s}` : `${s}-${p}`);
  console.log(ranges.join(" "));
  console.log("uncalled fns:", [...f.fns].filter(([, h]) => h === 0).map(([n]) => n).join(", "));
}
