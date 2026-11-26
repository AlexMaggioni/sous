// `sous doctor`: the installed Claude Code and Codex that the steps run on, how sous found them, and
// whether sous talks to them. The talk check lists each program's models, which sends no prompt.
// `--live` runs one tiny step on each, which uses the account a little. Both run on the account
// sous uses for new runs. It also checks where each program finds the sous skill, and that sous
// can write to its home, which the Codex sandbox may block.

import { checkPrograms, DEFAULT, describeAccount, folderText, homePaths, homeWriteProblem, loadConfig, skillPlaces, type ProgramReport, type SkillPlace } from "@sous-run/engine";
import { homeAdvice, reply, underCodex, type Next, type Reply } from "./reply.js";

export interface DoctorOptions {
  live?: boolean;
  /** With live, check this model only, such as codex/gpt-6.1-sol. */
  model?: string;
  /** The caller's environment: where each program finds skills, and whether Codex calls. */
  env: NodeJS.ProcessEnv;
  /** The sous skill folder. */
  skillDir: string;
}

const SOURCE: Record<string, string> = {
  variable: "from its variable",
  config: "from config.json",
  path: "found on PATH",
  "usual folder": "found in a usual install folder",
};

/** Where each program finds the sous skill, as `sous skill check` and `sous doctor` report it. */
export function checkSkill(skillDir: string, env: NodeJS.ProcessEnv): { programs: SkillPlace[]; notes: string[]; next: Next[]; words: Map<string, string> } {
  const { places: programs, blocked, change, stale } = skillPlaces(skillDir, env);
  const notes = [
    ...blocked.map((place) => `${place} holds something sous did not put there.`),
    ...(change ? [change] : []),
    ...stale.map(({ place, target }) => `${place} links to ${target}, which is gone. sous skill install replaces it.`),
  ];
  const word = (p: SkillPlace) => (p.ours ? "links to this skill" : stale.some((old) => old.place === p.place) ? "is an old sous link to a folder that is gone" : p.installed ? "holds something sous did not put there" : "is empty");
  const installs = !blocked.length && programs.some((p) => !p.ours);
  return {
    programs,
    notes,
    next: installs ? [{ call: "sous skill install --json", does: "links the skill for each program" }] : [],
    words: new Map(programs.map((p) => [p.program, `${p.place} ${word(p)}`])),
  };
}

/** The text lines of one program's report. */
function programLines(report: ProgramReport, skill: string | undefined): string[] {
  const lines = [`${report.name}${report.version ? ` ${report.version}` : ""}`];
  if (!report.path) return [...lines, `  missing   ${report.problem}`];
  lines.push(`  program   ${report.path}, ${SOURCE[report.source!] ?? report.source}`);
  for (const path of report.skipped) lines.push(`  skipped   ${path}, a wrapper script`);
  for (const other of report.others) lines.push(`  also      ${other.path}${other.version ? ` ${other.version}` : ""}, not used`);
  const end = skill ? [`  skill     ${skill}`] : [];
  if (report.problem) return [...lines, `  version   ${report.problem}`, ...end];
  const named = report.account !== DEFAULT;
  const account = `${describeAccount(report.program, { name: report.account, folder: report.folder })}${named ? `, settings in ${folderText(report.program, report.folder)}` : ""}`;
  lines.push(`  account   ${account} (${report.program === "claude" ? "sous account lists the others" : `set ${report.variable} where sous starts to use another`})`);
  if (report.talks) {
    lines.push(`  talks     yes`);
    if (report.models?.length) lines.push(`  models    ${report.models.join(", ")}`);
  } else {
    lines.push(`  talks     no: ${report.talkError}`);
  }
  if (report.live) lines.push(report.live.error ? `  live      ${report.live.model} failed: ${report.live.error}` : `  live      ${report.live.model} answered "${report.live.answer}"`);
  return [...lines, ...end];
}

/** The doctor's report. It exits 1 when a program fails a check or sous can't write to its home. */
export async function doctor(options: DoctorOptions): Promise<Reply<object>> {
  const paths = homePaths();
  const reports = await checkPrograms(paths, loadConfig(paths), { ...(options.live ? { live: true } : {}), ...(options.model ? { model: options.model } : {}) });
  const skill = checkSkill(options.skillDir, options.env);
  const problem = homeWriteProblem(paths);
  const home = { path: paths.home, writable: !problem, ...(problem ? { problem } : {}) };

  const notes = [...skill.notes];
  if (problem) notes.push(underCodex(options.env) ? `sous can't write to ${paths.home}. ${homeAdvice(paths.home)}` : `sous can't write to ${paths.home}. Give your user write access to it, or set SOUS_HOME to a folder it can write.`);
  const failed = !!problem || reports.some((report) => report.problem || report.talks === false || report.live?.error);
  const text = [
    ...reports.flatMap((report) => programLines(report, skill.words.get(report.program))),
    `sous home ${paths.home}`,
    problem ? `  writable  no: ${problem}` : "  writable  yes",
  ];
  return reply({ programs: reports, skills: skill.programs, home }, { exit: failed ? 1 : 0, text, notes, next: skill.next });
}
