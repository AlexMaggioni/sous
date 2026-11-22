// `orc doctor`: the installed Claude Code and Codex that the steps run on, how orc found them, and
// whether orc talks to them. The talk check opens a session on each and lists its models, which
// sends no prompt. `--live` runs one tiny step on each, which uses the account a little. Both run
// on the account orc uses for new runs.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createAcpRunner } from "@orchestrator/acp-agents";
import { routeHarness } from "./agents.js";
import { applyAccounts, currentAccount, DEFAULT, describeAccount, folderText } from "./accounts.js";
import { homePaths, loadConfig } from "./home.js";
import { claudeFolder, codexFolder, findProgram, PROGRAM_INFO, PROGRAMS, programVersion, type Program } from "./programs.js";

export interface DoctorOptions {
  live?: boolean;
  /** With live, check this model only, such as codex/gpt-6.1-sol. */
  model?: string;
  json?: boolean;
  out?: (line: string) => void;
}

interface Choice {
  value: string;
  name?: string;
}

export interface ProgramReport {
  program: Program;
  name: string;
  path?: string;
  version?: string;
  source?: string;
  skipped: string[];
  others: Array<{ path: string; version?: string }>;
  /** Where the program keeps its settings, and its own login, for orc's steps. */
  folder: string;
  /** The account orc uses for new runs. default is the program's own login. */
  account: string;
  problem?: string;
  talks?: boolean;
  models?: Choice[];
  defaultModel?: string;
  talkError?: string;
  live?: { model: string; answer?: string; error?: string };
}

const SOURCE: Record<string, string> = {
  variable: "from its variable",
  config: "from config.json",
  path: "found on PATH",
  "usual folder": "found in a usual install folder",
};

function choicesOf(option: { options?: unknown }): Choice[] {
  const out: Choice[] = [];
  for (const entry of (option.options as Array<Record<string, unknown>> | undefined) ?? []) {
    const group = entry.options as Array<Record<string, unknown>> | undefined;
    for (const choice of group ?? [entry]) {
      if (typeof choice.value === "string") out.push({ value: choice.value, ...(typeof choice.name === "string" ? { name: choice.name } : {}) });
    }
  }
  return out;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 400);

export async function doctor(options: DoctorOptions = {}): Promise<number> {
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const paths = homePaths();
  const config = loadConfig(paths);
  const asked = options.model ? routeHarness(options.model) : undefined;
  const reports: ProgramReport[] = [];
  // orc keeps no Codex accounts yet, so Codex always runs on its own login.
  const account = (program: Program) => (program === "claude" ? currentAccount(paths, program) : DEFAULT);
  const restore = applyAccounts(paths, account("claude") === DEFAULT ? undefined : { claude: { name: account("claude"), folder: process.env.CLAUDE_CONFIG_DIR ?? null } });

  for (const program of PROGRAMS) {
    const info = PROGRAM_INFO[program];
    const found = findProgram(program, { config });
    const folder = program === "claude" ? claudeFolder() : codexFolder();
    if ("problem" in found) {
      reports.push({ program, name: info.name, skipped: found.skipped, others: [], folder, account: account(program), problem: found.problem });
      continue;
    }
    // The adapters read these when they start.
    process.env[info.variable] = found.path;
    reports.push({
      program,
      name: info.name,
      path: found.path,
      version: programVersion(found.path),
      source: found.source,
      skipped: found.skipped,
      others: found.others.map((path) => ({ path, version: programVersion(path) })),
      folder,
      account: account(program),
    });
  }

  const cwd = join(paths.scratch, "doctor");
  mkdirSync(cwd, { recursive: true });
  const runner = createAcpRunner();
  try {
    for (const report of reports) {
      if (report.problem) continue;
      try {
        const probed = await runner.probeConfigOptions(report.program, { cwd, signal: AbortSignal.timeout(120_000) });
        const model = probed.options.find((option) => option.id === "model" && option.type === "select");
        report.talks = true;
        if (model) {
          report.models = choicesOf(model as { options?: unknown });
          if (typeof (model as { currentValue?: unknown }).currentValue === "string") report.defaultModel = (model as { currentValue: string }).currentValue;
        }
      } catch (error) {
        report.talks = false;
        report.talkError = message(error);
      }
      if (!options.live || !report.talks || (asked && asked !== report.program)) continue;
      const spec = asked ? options.model! : report.program;
      const live: NonNullable<ProgramReport["live"]> = { model: asked ? options.model! : `${report.program}/${report.defaultModel ?? "default"}` };
      try {
        const answer = await runner.run("Answer with the single word OK.", { model: spec, cwd, label: "orc doctor", signal: AbortSignal.timeout(300_000) } as never);
        live.answer = (typeof answer === "string" ? answer : JSON.stringify(answer)).trim().slice(0, 200);
      } catch (error) {
        live.error = message(error);
      }
      report.live = live;
    }
  } finally {
    await (runner as { dispose?: () => Promise<void> | void }).dispose?.();
    restore();
  }

  const failed = reports.some((report) => report.problem || report.talks === false || report.live?.error);
  if (options.json) {
    out(JSON.stringify(reports, null, 2));
    return failed ? 1 : 0;
  }
  for (const report of reports) {
    out(`${report.name}${report.version ? ` ${report.version}` : ""}`);
    if (report.problem) {
      out(`  missing   ${report.problem}`);
      continue;
    }
    out(`  program   ${report.path}, ${SOURCE[report.source!] ?? report.source}`);
    for (const path of report.skipped) out(`  skipped   ${path}, a wrapper script`);
    for (const other of report.others) out(`  also      ${other.path}${other.version ? ` ${other.version}` : ""}, not used`);
    const named = report.account !== DEFAULT;
    const account = `${describeAccount(report.program, { name: report.account, folder: report.folder })}${named ? `, settings in ${folderText(report.program, report.folder)}` : ""}`;
    out(`  account   ${account} (${report.program === "claude" ? "orc account lists the others" : "set CODEX_HOME where orc starts to use another"})`);
    if (report.talks) {
      const models = (report.models ?? []).map((choice) => (choice.name && choice.name !== choice.value ? `${choice.value} (${choice.name})` : choice.value));
      out(`  talks     yes${report.defaultModel ? `, default model ${report.defaultModel}` : ""}`);
      if (models.length) out(`  models    ${models.join(", ")}`);
    } else {
      out(`  talks     no: ${report.talkError}`);
    }
    if (report.live) out(report.live.error ? `  live      ${report.live.model} failed: ${report.live.error}` : `  live      ${report.live.model} answered "${report.live.answer}"`);
  }
  return failed ? 1 : 0;
}
