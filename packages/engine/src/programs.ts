// The installed Claude Code and Codex, as `orc doctor` and `orc account add` see them. Each check
// goes through the harness: find, version, models, and for `--live` one step.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHarness, type FindOptions } from "@orchestrator/harnesses";
import { CALLER, currentAccount, DEFAULT, stepAccount } from "./accounts.js";
import { envFor, HARNESSES, harnessName, loginOf, routeHarness, stepModel, type Harness } from "./agents.js";
import type { HomePaths, OrcConfig } from "./runs/home.js";

/** Where to look for each program: the path config.json gives, then the harness's own order. */
export function programLookup(config: OrcConfig): (harness: Harness) => FindOptions {
  return (harness) => {
    const key = harness === "claude" ? "claudePath" : "codexPath";
    const path = config[key];
    return { ...(path ? { path } : {}), setting: `${key} in ~/.orchestrator/config.json` };
  };
}

export interface ProgramReport {
  program: Harness;
  name: string;
  path?: string;
  version?: string;
  source?: string;
  skipped: string[];
  others: Array<{ path: string; version?: string }>;
  /** Where the program keeps its settings, and its own login, for orc's steps. */
  folder: string;
  /** The variable that moves the folder. */
  variable: string;
  /** The account orc uses for new runs. default is the program's own login. */
  account: string;
  /** No program, or one the harness does not support. */
  problem?: string;
  talks?: boolean;
  models?: string[];
  talkError?: string;
  live?: { model: string; answer?: string; error?: string };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 400);

/**
 * Each program, how it was found, its version and models. With live, one tiny step on each, or
 * only on the harness of model. Both run on the account orc uses for new runs.
 */
export async function checkPrograms(paths: HomePaths, config: OrcConfig, options: { live?: boolean; model?: string } = {}): Promise<ProgramReport[]> {
  const asked = options.model ? routeHarness(options.model) : undefined;
  const lookup = programLookup(config);
  const cwd = join(paths.scratch, "doctor");
  mkdirSync(cwd, { recursive: true });
  const reports: ProgramReport[] = [];
  for (const program of HARNESSES) {
    // orc keeps no Codex accounts yet, so Codex always runs on its own login.
    const name = program === "claude" ? currentAccount(paths, program) : DEFAULT;
    const { folder, variable } = loginOf(program);
    const account = name === DEFAULT || name === CALLER ? undefined : stepAccount(paths, program, { name, folder: loginOf(program).value ?? null });
    const adapter = createHarness(program, lookup(program));
    const report: ProgramReport = { program, name: harnessName(program), skipped: [], others: [], folder, variable, account: name };
    reports.push(report);
    const found = adapter.find();
    report.skipped = found.skipped;
    if ("problem" in found) {
      report.problem = found.problem;
      continue;
    }
    const { version, problem } = await adapter.version(found.path);
    Object.assign(report, { path: found.path, source: found.source, ...(version ? { version } : {}) });
    for (const path of found.others) {
      const other = (await adapter.version(path)).version;
      report.others.push({ path, ...(other ? { version: other } : {}) });
    }
    if (problem) {
      report.problem = problem;
      continue;
    }
    try {
      report.models = await adapter.models(account);
      report.talks = true;
    } catch (error) {
      report.talks = false;
      report.talkError = message(error);
    }
    if (!options.live || !report.talks || (asked && asked !== program)) continue;
    // The model as a step would take it: a bare name, such as haiku, runs on its own.
    const model = stepModel(options.model);
    const live: NonNullable<ProgramReport["live"]> = { model: asked ? options.model! : `${program}/default` };
    try {
      const result = await adapter.run({ prompt: "Answer with the single word OK.", cwd, ...(account ? { account } : {}), ...(model ? { model } : {}), signal: AbortSignal.timeout(300_000) });
      if (!asked && result.model) live.model = `${program}/${result.model}`;
      live.answer = result.text.trim().slice(0, 200);
    } catch (error) {
      live.error = message(error);
    }
    report.live = live;
  }
  return reports;
}

/** Claude Code with the environment `claude setup-token` needs, or why it can't start. */
export function setupTokenProgram(config: OrcConfig): { path: string; env: Record<string, string | undefined> } | { problem: string } {
  const found = createHarness("claude", programLookup(config)("claude")).find();
  if ("problem" in found) return { problem: found.problem };
  // The login it makes is for the browser account, whatever this shell is logged in with.
  return { path: found.path, env: envFor("claude", { folder: loginOf("claude").value, named: true }) };
}
