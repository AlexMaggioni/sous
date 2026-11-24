// sous account and doctor: the logins and programs the steps run on. sous guide, skill and hook:
// what an agent that drives sous reads, and the line a new Claude Code session gets.

import { join, resolve } from "node:path";
import { installHook, installSkill, Refusal, removeHook } from "@sous/engine";
import { cmdAccount as accountCommand } from "../account-cli.js";
import { str, Usage, type Parsed } from "../args.js";
import { checkSkill, doctor } from "../doctor.js";
import { reply, type Reply } from "../reply.js";
import type { Ctx } from "./index.js";

export async function cmdAccount(args: Parsed, ctx: Ctx): Promise<Reply<object>> {
  // account-cli.ts prints as it goes, since add asks in the terminal, and gives an exit code, or a
  // reply with --json. The workers start through ctx.launch, read only when one starts, so a
  // listing needs no build.
  const done = await accountCommand(args.positional, { json: ctx.json, usage: (message) => new Usage(message), launch: (...start) => ctx.launch(...start) });
  return typeof done === "number" ? reply({}, { exit: done }) : done;
}

export function cmdDoctor(args: Parsed, ctx: Ctx): Promise<Reply<object>> {
  return doctor({ live: args.flags.live === true, model: str(args.flags.model), env: ctx.env, skillDir: resolve(ctx.machine.skillDir) });
}

/** The guide topics in reading order, each with its line in the list. Each is guide/<name>.md. */
const TOPICS: ReadonlyArray<{ name: string; about: string }> = [
  { name: "start", about: "start a run for a person and read the reply" },
  { name: "wait", about: "wait for a run in the background, and what each exit code means" },
  { name: "asks", about: "a run asks a question: the person answers, you pass it on" },
  { name: "ends", about: "a run ended: read the result and the diff before you report" },
  { name: "pauses", about: "failures, the usage limit and pauses: resume, rerun or stop" },
  { name: "steer", about: "pause the run, or stop one step or the whole run" },
  { name: "writing", about: "write a workflow and check it before it runs" },
  { name: "errors", about: "the error shape, the exit codes and what to do with each" },
  { name: "inside", about: "you are a step of a run: what you call and what you leave" },
  { name: "replies", about: "the JSON replies: notes, next and each command's keys" },
];

export function cmdGuide(args: Parsed, ctx: Ctx): Reply<object> {
  const name = args.positional[0];
  if (name === undefined) {
    const width = Math.max(...TOPICS.map((topic) => topic.name.length));
    return reply(
      { topics: TOPICS },
      {
        text: ["Topics. sous guide <topic> prints one.", ...TOPICS.map((topic) => `  ${topic.name.padEnd(width)}  ${topic.about}`)],
        next: [{ call: "sous guide start --json", does: "how to start a run for a person" }],
      },
    );
  }
  if (!TOPICS.some((topic) => topic.name === name)) {
    throw new Refusal("no_such_topic", `sous guide has no topic "${name}".`, `Use one of: ${TOPICS.map((topic) => topic.name).join(", ")}.`, "sous guide --json");
  }
  const text = ctx.machine.readText(join(ctx.machine.guideDir, `${name}.md`));
  return reply({ topic: name, text }, { text: [text.trimEnd()] });
}

/** sous skill install, path and check: the sous skill in Claude Code's and Codex's skill folders. */
export function cmdSkill(args: Parsed, ctx: Ctx): Reply<object> {
  const action = args.positional[0];
  const folder = resolve(ctx.machine.skillDir);
  if (action === "path") return reply({ path: folder }, { text: [folder] });
  if (action === "install") {
    const { programs, replaced } = installSkill(folder, ctx.env);
    const notes = replaced.map(({ place, target }) => `${place} linked to ${target}, which is gone. It now links to this skill.`);
    return reply(
      { programs },
      {
        text: programs.map(({ program, place, already }) => `${program}: ${place} ${already ? "already links to the skill" : "now links to the skill"}`),
        notes: [...notes, "A new session loads the skill. A session that is open now does not."],
        next: [{ call: "sous skill check --json", does: "shows where each program finds the skill" }],
      },
    );
  }
  if (action === "check") {
    const { programs, notes, next, words } = checkSkill(folder, ctx.env);
    return reply({ programs }, { text: programs.map((p) => `${p.program}: ${words.get(p.program)}`), notes, next });
  }
  throw new Usage("give install, path or check: sous skill install|path|check");
}

/** sous hook install and remove: the SessionStart hook in Claude Code's settings that runs
 *  `sous status --line`, so a new session hears what needs the person. Codex gets none yet. */
export function cmdHook(args: Parsed, ctx: Ctx): Reply<object> {
  const action = args.positional[0];
  if (action === "install") {
    const { settings, command, changed, backup } = installHook(ctx.env);
    return reply(
      { settings, command, already: !changed, backup },
      {
        text: [changed ? `${settings} now runs ${command} when a Claude Code session starts.` : `${settings} already runs ${command} when a Claude Code session starts.`],
        notes: [
          ...(backup ? [`The file as it was before sous first edited it is in ${backup}.`] : []),
          "A new session runs the hook. A session that is open now does not.",
          "Codex gets no hook. Its hook format is not checked yet.",
        ],
        next: [{ call: "sous status --line --json", does: "gives the line the hook prints in a new session, empty when nothing needs you" }],
      },
    );
  }
  if (action === "remove") {
    const { settings, command, changed } = removeHook(ctx.env);
    return reply(
      { settings, command, removed: changed },
      {
        text: [changed ? `Removed ${command} from ${settings}.` : `Left ${settings} as it was.`],
        notes: changed ? [] : ["No sous hook to remove."],
      },
    );
  }
  throw new Usage("give install or remove: sous hook install|remove");
}
