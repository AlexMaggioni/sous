// Runs each test alone with coverage. Usage: node per-test-cov.mjs <package dir> <tests.jsonl> <out.jsonl> [concurrency]
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const [pkg, listPath, outPath, conc = "6"] = process.argv.slice(2);
const pkgDir = resolve(pkg);
const tsx = resolve(pkgDir, "../../node_modules/.bin/tsx");
const rows = readFileSync(listPath, "utf8").trim().split("\n").map(JSON.parse).filter((r) => r.type !== "suite");
writeFileSync(outPath, "");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function parseLcov(text) {
  const out = {};
  let cur, name;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) { name = line.slice(3); cur = name.startsWith("src/") ? { l: [], b: [] } : undefined; if (cur) out[name] = cur; }
    else if (!cur) continue;
    else if (line.startsWith("DA:")) { const [n, h] = line.slice(3).split(",").map(Number); if (h > 0) cur.l.push(n); }
    else if (line.startsWith("BRDA:")) { const p = line.slice(5).split(","); if (p[3] !== "-" && Number(p[3]) > 0) cur.b.push(`${p[0]}.${p[1]}.${p[2]}`); }
  }
  return out;
}

let next = 0, done = 0;
async function worker() {
  while (next < rows.length) {
    const row = rows[next++];
    const scratch = mkdtempSync(join(tmpdir(), "ptc-"));
    const lcov = join(scratch, "c.lcov");
    const env = { ...process.env, HOME: join(scratch, "home"), CLAUDE_CONFIG_DIR: join(scratch, "claude"), CODEX_HOME: join(scratch, "codex") };
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    const args = ["--test", "--experimental-test-coverage", "--test-reporter=lcov", `--test-reporter-destination=${lcov}`, "--test-reporter=dot", "--test-reporter-destination=stdout",
      `--test-name-pattern=^${esc(row.name)}$`, relative(pkgDir, row.file)];
    const started = Date.now();
    const code = await new Promise((res) => { const c = spawn(tsx, args, { cwd: pkgDir, env, stdio: "ignore" }); c.on("exit", res); });
    const cov = existsSync(lcov) ? parseLcov(readFileSync(lcov, "utf8")) : {};
    appendFileSync(outPath, JSON.stringify({ file: relative(pkgDir, row.file), name: row.name, path: row.path, code, wall: Date.now() - started, ms: row.ms, cov }) + "\n");
    rmSync(scratch, { recursive: true, force: true });
    done++;
    if (done % 50 === 0) console.log(`${done}/${rows.length}`);
  }
}
await Promise.all(Array.from({ length: Number(conc) }, worker));
console.log("done", done);
