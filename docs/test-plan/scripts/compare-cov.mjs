import { readFileSync } from "node:fs";
function parse(path, strip) {
  const files = new Map(); let cur;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.startsWith("SF:")) { const n = line.slice(3).replace(strip, ""); cur = new Map(); files.set(n, cur); }
    else if (line.startsWith("DA:")) { const [n, h] = line.slice(3).split(",").map(Number); cur.set(n, h); }
  }
  return files;
}
const eng = parse(process.argv[2], /^/);
const orc = parse(process.argv[3], /^\.\.\/engine\//);
let T = 0, E = 0, O = 0, both = 0, onlyE = 0, onlyO = 0, none = 0;
const rows = [];
for (const [f, lines] of eng) {
  if (!f.startsWith("src/")) continue;
  const o = orc.get(f) ?? new Map();
  let t = 0, e = 0, oo = 0, b = 0, oe = 0, on = 0, n = 0;
  for (const [l, h] of lines) { t++; const oh = (o.get(l) ?? 0) > 0; if (h > 0) e++; if (oh) oo++; if (h > 0 && oh) b++; else if (h > 0) oe++; else if (oh) on++; else n++; }
  T += t; E += e; O += oo; both += b; onlyE += oe; onlyO += on; none += n;
  rows.push({ f, t, e, oo, oe, on, n, has: orc.has(f) });
}
rows.sort((a, b) => b.oe - a.oe);
console.log("file".padEnd(50), "lines  engT  orcT  onlyEng onlyOrc none");
for (const r of rows) console.log(r.f.padEnd(50), String(r.t).padStart(5), String(r.e).padStart(5), String(r.has ? r.oo : "-").padStart(5), String(r.oe).padStart(7), String(r.on).padStart(7), String(r.n).padStart(5));
console.log(`TOTAL ${T}: engine tests ${E} (${(100 * E / T).toFixed(1)}%), orc tests ${O} (${(100 * O / T).toFixed(1)}%), only engine ${onlyE}, only orc ${onlyO}, neither ${none}, union ${(100 * (T - none) / T).toFixed(1)}%`);
