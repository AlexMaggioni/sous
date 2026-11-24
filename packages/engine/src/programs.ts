// The installed Claude Code and Codex, as `sous doctor` and `sous account add` see them. Each check
// goes through the harness: find, version, models, and for `--live` one step.

import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { createHarness, type FindOptions, type HarnessId } from "@sous/harnesses";
import { CALLER, currentAccount, DEFAULT, stepAccount } from "./accounts.js";
import { envFor, HARNESSES, harnessName, loginOf, routeHarness, stepModel } from "./agents.js";
import type { HomePaths, OrcConfig } from "./runs/home.js";
import { HOOK_COMMAND, type Settings, withoutSessionHook, withSessionHook } from "./hook-settings.js";
import { recordAction, type Who } from "./runs/actions.js";
import { Refusal } from "./runs/refusal.js";

/** Where to look for each program: the path config.json gives, then the harness's own order. */
export function programLookup(config: OrcConfig): (harness: HarnessId) => FindOptions {
  return (harness) => {
    const key = harness === "claude" ? "claudePath" : "codexPath";
    const path = config[key];
    return { ...(path ? { path } : {}), setting: `${key} in ~/.sous/config.json` };
  };
}

export interface ProgramReport {
  program: HarnessId;
  name: string;
  path?: string;
  version?: string;
  source?: string;
  skipped: string[];
  others: Array<{ path: string; version?: string }>;
  /** Where the program keeps its settings, and its own login, for sous's steps. */
  folder: string;
  /** The variable that moves the folder. */
  variable: string;
  /** The account sous uses for new runs. default is the program's own login. */
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
 * only on the harness of model. Both run on the account sous uses for new runs.
 */
export async function checkPrograms(paths: HomePaths, config: OrcConfig, options: { live?: boolean; model?: string } = {}): Promise<ProgramReport[]> {
  const asked = options.model ? routeHarness(options.model) : undefined;
  const lookup = programLookup(config);
  // Made only for a live step, so a home sous cannot write still gets its report.
  const cwd = join(paths.scratch, "doctor");
  const reports: ProgramReport[] = [];
  for (const program of HARNESSES) {
    // sous keeps no Codex accounts yet, so Codex always runs on its own login.
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
      mkdirSync(cwd, { recursive: true });
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

// ── The sous skill in each program's skill folder ──

type Env = Record<string, string | undefined>;

export interface SkillPlace {
  program: HarnessId;
  /** The sous folder in the program's skill folder. */
  place: string;
  /** Something is there, a broken link included. */
  installed: boolean;
  /** It is a link to this sous's skill folder. */
  ours: boolean;
}

/** What each place holds, and what an install would do. */
export interface SkillCheck {
  places: SkillPlace[];
  /** The places that hold something sous did not put there. An install refuses while there are any. */
  blocked: string[];
  /** What to do about blocked, for a refusal or a note. */
  change?: string;
  /** Broken links sous made to a skill folder that is gone, as when a worktree is removed. An
   *  install replaces them. */
  stale: Array<{ place: string; target: string }>;
}

/** realpath, or undefined when the path is missing or a broken link. */
function real(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** What lstat finds at path: a link, something else, or nothing. */
function kindAt(path: string): "link" | "other" | undefined {
  try {
    return lstatSync(path).isSymbolicLink() ? "link" : "other";
  } catch {
    return undefined;
  }
}

/** The target of the broken link at place when it ends in the skill folder's own tail, such as
 *  cli/skill/sous, so sous made it from a checkout or worktree that is gone. */
function staleTarget(place: string, skillDir: string): string | undefined {
  const target = resolve(dirname(place), readlinkSync(place));
  const tail = resolve(skillDir).split(sep).slice(-3).join(sep);
  return target.endsWith(sep + tail) ? target : undefined;
}

/** Where each program looks for the sous skill, and what is there now. */
export function skillPlaces(skillDir: string, env: Env): SkillCheck {
  const ourReal = real(skillDir);
  const check: SkillCheck = { places: [], blocked: [], stale: [] };
  for (const program of HARNESSES) {
    const place = join(createHarness(program).places(env).skills, "sous");
    const kind = kindAt(place);
    const target = kind === "link" ? real(place) : undefined;
    const ours = target !== undefined && target === ourReal;
    check.places.push({ program, place, installed: kind !== undefined, ours });
    if (kind === undefined || ours) continue;
    const old = kind === "link" && target === undefined ? staleTarget(place, skillDir) : undefined;
    if (old) check.stale.push({ place, target: old });
    else check.blocked.push(place);
  }
  if (check.blocked.length) check.change = `Move ${check.blocked.join(" and ")} aside, or remove it if it is an old sous skill, then install again.`;
  return check;
}

/**
 * Links each program's sous skill place to skillDir, in place of a broken link sous made before. A
 * place that holds anything else refuses the whole install before any write.
 */
export function installSkill(skillDir: string, env: Env): { programs: Array<{ program: HarnessId; place: string; already: boolean }>; replaced: SkillCheck["stale"] } {
  const check = skillPlaces(skillDir, env);
  const { blocked } = check;
  if (blocked.length) {
    const list = blocked.join(" and ");
    throw new Refusal("not_ours", `${list} already ${blocked.length > 1 ? "hold" : "holds"} something sous did not put there.`, check.change!, "sous skill install --json");
  }
  const programs = check.places.map(({ program, place, ours }) => {
    if (!ours) {
      if (check.stale.some((old) => old.place === place)) unlinkSync(place);
      mkdirSync(dirname(place), { recursive: true });
      symlinkSync(resolve(skillDir), place);
    }
    return { program, place, already: ours };
  });
  return { programs, replaced: check.stale };
}

// ── The session-start hook in Claude Code's settings ──

export interface HookChange {
  /** Claude Code's settings file. */
  settings: string;
  command: string;
  /** The edit changed the file. */
  changed: boolean;
  /** The copy of the file as it was before sous first edited it, when there was a file. */
  backup: string | null;
}

interface SettingsRead {
  file: string;
  /** The file the edit writes: file, or the end of the link file is. Undefined when there is no file. */
  real: string | undefined;
  next: Settings | undefined;
}

/** Claude Code's settings file in env, and its value. A file that does not parse, has a shape
 *  sous can't edit, or is a broken link, refuses with not_ours and changes nothing. */
function readSettings(env: Env, action: "install" | "remove", edit: (value: unknown, command: string) => Settings | undefined): SettingsRead {
  const file = createHarness("claude").places(env).settings!;
  const call = `sous hook ${action} --json`;
  const refuse = (why: string) => new Refusal("not_ours", `${file} ${why}, so sous can't edit it.`, `Fix ${file} so it is a JSON object, or move it aside, then run the same command again.`, call);
  const kind = kindAt(file);
  if (kind === undefined) return { file, real: undefined, next: edit({}, HOOK_COMMAND) };
  const target = kind === "link" ? real(file) : file;
  if (target === undefined) {
    const points = resolve(dirname(file), readlinkSync(file));
    throw new Refusal("not_ours", `${file} is a broken link to ${points}, so sous can't edit it.`, `Point the link at ${file} to a settings file that is there, or remove the link, then run the same command again.`, call);
  }
  const text = readFileSync(target, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw refuse("does not parse as JSON");
  }
  try {
    return { file, real: target, next: edit(value, HOOK_COMMAND) };
  } catch (error) {
    throw refuse((error as Error).message);
  }
}

/** Write value over target in one step: a file next to it, renamed over it, with the old file's
 *  mode. target is the real file, so a link to a dotfiles folder stays a link. */
function writeSettings(target: string, value: Settings, mode: number | undefined): void {
  const temp = `${target}.sous-${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  try {
    if (mode !== undefined) chmodSync(temp, mode);
    renameSync(temp, target);
  } catch (error) {
    unlinkSync(temp);
    throw error;
  }
}

const modeOf = (file: string): number => statSync(file).mode & 0o7777;

/** Add sous's SessionStart hook to Claude Code's settings in env. Before the first change to a
 *  file that is there, copy it byte for byte to settings.json.sous-backup. A later install keeps
 *  that first copy. A change adds a hook-install line by `who` to events.jsonl. */
export function installHook(paths: HomePaths, env: Env, who: Who): HookChange {
  const { file, real: target, next } = readSettings(env, "install", withSessionHook);
  if (!next) return { settings: file, command: HOOK_COMMAND, changed: false, backup: null };
  const backup = target ? `${file}.sous-backup` : null;
  if (backup && !existsSync(backup)) copyFileSync(target!, backup, constants.COPYFILE_EXCL);
  if (!target) mkdirSync(dirname(file), { recursive: true });
  writeSettings(target ?? file, next, target ? modeOf(target) : undefined);
  recordAction(paths, { act: "hook-install", ...who, value: file });
  return { settings: file, command: HOOK_COMMAND, changed: true, backup };
}

/** Take sous's SessionStart hook out of Claude Code's settings in env. A file with no hook of
 *  sous's, or no file, stays as it is. A file the remove leaves empty goes when sous made it: it is
 *  no link and has no backup. A change adds a hook-remove line by `who` to events.jsonl. */
export function removeHook(paths: HomePaths, env: Env, who: Who): HookChange {
  const { file, real: target, next } = readSettings(env, "remove", withoutSessionHook);
  if (!target || !next) return { settings: file, command: HOOK_COMMAND, changed: false, backup: null };
  const made = !existsSync(`${file}.sous-backup`) && kindAt(file) === "other";
  if (made && !Object.keys(next).length) unlinkSync(file);
  else writeSettings(target, next, modeOf(target));
  recordAction(paths, { act: "hook-remove", ...who, value: file });
  return { settings: file, command: HOOK_COMMAND, changed: true, backup: null };
}
