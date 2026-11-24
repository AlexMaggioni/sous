// sous account and doctor: the logins and programs the steps run on. sous guide and skill: what
// an agent that drives sous reads.

import { join, resolve } from "node:path";
import { installSkill, Refusal, skillPlaces } from "@sous/engine";
import { cmdAccount as accountCommand } from "../account-cli.js";
import { str, Usage, type Parsed } from "../args.js";
import { doctor } from "../doctor.js";
import { reply, type Reply } from "../reply.js";
import type { Ctx } from "./index.js";

/** account-cli.ts and doctor.ts print as they go and give an exit code, or give a reply with --json.
 *  Tests call them on their own, so the command turns the code into a reply here. Piece 15 reworks doctor, and this with it. */
const asReply = async (result: Promise<number | Reply<object>>): Promise<Reply<object>> => {
  const done = await result;
  return typeof done === "number" ? reply({}, { exit: done }) : done;
};

export function cmdAccount(args: Parsed, ctx: Ctx): Promise<Reply<object>> {
  // The workers start through ctx.launch, read only when one starts, so a listing needs no build.
  return asReply(accountCommand(args.positional, { json: ctx.json, usage: (message) => new Usage(message), launch: (...start) => ctx.launch(...start) }));
}

export function cmdDoctor(args: Parsed, ctx: Ctx): Promise<Reply<object>> {
  return asReply(doctor({ live: args.flags.live === true, model: str(args.flags.model), json: ctx.json, out: ctx.machine.out }));
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
    const { places: programs, blocked, change, stale } = skillPlaces(folder, ctx.env);
    const notes = [
      ...blocked.map((place) => `${place} holds something sous did not put there.`),
      ...(change ? [change] : []),
      ...stale.map(({ place, target }) => `${place} links to ${target}, which is gone. sous skill install replaces it.`),
    ];
    const installs = !blocked.length && programs.some((p) => !p.ours);
    const word = (p: (typeof programs)[number]) => (p.ours ? "links to this skill" : stale.some((old) => old.place === p.place) ? "is an old sous link to a folder that is gone" : p.installed ? "holds something sous did not put there" : "is empty");
    return reply(
      { programs },
      {
        text: programs.map((p) => `${p.program}: ${p.place} ${word(p)}`),
        notes,
        next: installs ? [{ call: "sous skill install --json", does: "links the skill for each program" }] : [],
      },
    );
  }
  throw new Usage("give install, path or check: sous skill install|path|check");
}
