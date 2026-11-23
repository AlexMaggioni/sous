// For each mutant: build, then the other suites. Says which step catches it first, and all that catch it when --all.
//   node layer2.mjs <mutants.json> <ids.txt> <out.jsonl> <worker dir>...
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
const [mutantsPath, idsPath, outPath, ...workers] = process.argv.slice(2);
const all = new Map(JSON.parse(readFileSync(mutantsPath, "utf8")).map((m) => [m.id, m]));
const ids = readFileSync(idsPath, "utf8").trim().split("\n").filter(Boolean);
const done = new Set(existsSync(outPath) ? readFileSync(outPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).id) : []);
const reporter = resolve(new URL("./list-reporter.mjs", import.meta.url).pathname);
function run(cmd, args, cwd, env, ms) {
  return new Promise((res) => {
    let out = "";
    const c = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    c.stdout.on("data", (d) => { out += d; }); c.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => { try { process.kill(-c.pid, "SIGKILL"); } catch {} res({ code: "timeout", out }); }, ms);
    c.on("exit", (code) => { clearTimeout(timer); res({ code, out }); });
  });
}
const failedOf = (out, base) => out.split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && !r.ok && r.type !== "suite").map((r) => `${relative(base, r.file ?? "")}::${r.name}`);
let next = 0, finished = 0;
async function work(dir) {
  const root = resolve(dir);
  const tsc = join(root, "node_modules/.bin/tsc"), tsx = join(root, "node_modules/.bin/tsx");
  while (next < ids.length) {
    const m = all.get(ids[next++]);
    if (!m || done.has(m.id)) continue;
    const pkgDir = join(root, "packages", m.pkg);
    const path = join(pkgDir, m.file);
    const original = readFileSync(path, "utf8");
    writeFileSync(path, original.slice(0, m.start) + m.repl + original.slice(m.end));
    const scratch = mkdtempSync(join(tmpdir(), "l2-"));
    const env = { ...process.env, HOME: join(scratch, "home"), CLAUDE_CONFIG_DIR: join(scratch, "claude"), CODEX_HOME: join(scratch, "codex") };
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    const r = { id: m.id, file: m.file, line: m.line, op: m.op };
    const started = Date.now();
    const build = await run(tsc, ["-b"], pkgDir, env, 120_000);
    if (build.code !== 0) { r.build = "fails"; r.buildError = build.out.split("\n").find((l) => l.includes("error TS"))?.slice(0, 160); }
    else {
      r.build = "ok";
      if (m.pkg !== "orc") {
        const own = m.pkg === "harnesses" ? await run(tsx, ["--test", `--test-reporter=${reporter}`, "--test-reporter-destination=stdout", "test/**/*.test.ts"], pkgDir, env, 120_000) : null;
        if (own) { r.own = own.code === 0 ? "pass" : "fail"; r.ownFailed = failedOf(own.out, pkgDir).slice(0, 30); }
      }
      if (m.pkg === "orc") await run(tsc, ["-b"], join(root, "packages/orc"), env, 120_000);
      const orcDir = join(root, "packages/orc");
      const orc = await run(tsx, ["--test", `--test-reporter=${reporter}`, "--test-reporter-destination=stdout", "test/**/*.test.ts"], orcDir, env, 240_000);
      r.orc = orc.code === 0 ? "pass" : orc.code === "timeout" ? "timeout" : "fail"; r.orcFailed = failedOf(orc.out, orcDir).slice(0, 40);
      const base = await run(process.execPath, ["--test", "test/baseline.test.mjs"], root, env, 300_000);
      r.baseline = base.code === 0 ? "pass" : base.code === "timeout" ? "timeout" : "fail";
      if (r.baseline === "fail") r.baselineFiles = [...new Set((base.out.match(/^[-+]{3} .*golden\/[\w.-]+/gm) ?? []).map((l) => l.split("golden/")[1]))].slice(0, 12);
    }
    writeFileSync(path, original);
    rmSync(scratch, { recursive: true, force: true });
    r.wall = Date.now() - started;
    appendFileSync(outPath, JSON.stringify(r) + "\n");
    finished++;
    if (finished % 5 === 0) console.log(`${finished}`);
  }
  await run(tsc, ["-b"], join(root, "packages/engine"), process.env, 120_000);
  await run(tsc, ["-b"], join(root, "packages/orc"), process.env, 120_000);
}
await Promise.all(workers.map(work));
console.log("done");
