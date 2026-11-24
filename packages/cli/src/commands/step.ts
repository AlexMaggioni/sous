// sous step: one step of a run, with what it did.

import { stepView, type StepView } from "@sous/engine";
import { Usage, type Parsed } from "../args.js";
import { reply, type Reply } from "../reply.js";
import { runIdArg, wholeFlag } from "./common.js";
import type { Ctx } from "./index.js";
import { stepNext } from "./next.js";

/** How long the printed reply of sous step --json may be, as every JSON reply. */
const STEP_REPLY_MAX = 8000;

type Shown = Omit<StepView, "earlier" | "promptCut">;

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};

/** The step as lines a person reads. */
function stepText(view: Shown): string[] {
  const time = [view.seconds === undefined ? "" : `${view.seconds}s`, view.tokens ? `${view.tokens} tokens` : ""].filter(Boolean).join(", ");
  const lines = [`step ${view.step} of run ${view.runId}, call ${view.call} of ${view.calls}: ${view.status} (${view.kind}${view.model ? ` ${view.model}` : ""}${time ? `, ${time}` : ""})`];
  if (view.command !== undefined) lines.push(`command: ${view.command}`);
  if (view.prompt !== undefined) lines.push(`prompt: ${oneLine(view.prompt, 200)}`);
  if (view.failure !== undefined) lines.push(`failure: ${view.failure}`);
  if (view.activity.length) lines.push("activity:");
  for (const line of view.activity) lines.push(`  ${line.at.slice(11, 19)} ${line.kind.padEnd(11)} ${line.tool ? `${line.tool}: ` : ""}${oneLine(line.text, 300)}`);
  return lines;
}

export function cmdStep(args: Parsed, ctx: Ctx): Reply<object> {
  const id = runIdArg(args.positional[0]);
  const label = args.positional[1];
  if (!label) throw new Usage("give the step's label after the run id, such as sous step <run> <label>", "bad_argument", undefined, `sous show ${id} --json`);
  const call = wholeFlag(args, "call", 1);
  const tail = wholeFlag(args, "tail", 0);
  const full = args.flags.full === true;
  const { earlier, promptCut, ...view } = stepView(ctx.paths, id, label, { ...(call === undefined ? {} : { call }), ...(tail === undefined ? {} : { tail }), full });
  const notes: string[] = [];
  if (earlier) notes.push(`${earlier} older activity entries are not shown. Add --tail ${earlier + view.activity.length} to see them.`);
  if (promptCut) notes.push("The prompt is cut to 2,000 characters. Add --full to see all of it.");
  if (view.calls > 1 && call === undefined) notes.push(`This is the last of ${view.calls} calls. Add --call n to see another.`);
  const next = stepNext(view.runId, view.step, view.status);
  // main prints no next call in text, since each takes --json. A person reading a step wants the
  // way on, so the text names them.
  if (!ctx.json) return reply(view, { notes, text: [...stepText(view), ...next.map((one) => `next: ${one.call}  (${one.does})`)] });
  // The oldest entries go first when the reply is too long. --full keeps them.
  const printed = (shown: Shown, more: string[]) => JSON.stringify({ ...shown, notes: more, next }, null, 2).length;
  let shown = view;
  let dropped = 0;
  const sizeNote = () => [...notes, `${dropped} older activity entries are left out to keep the reply under 8,000 characters. Add --full to see them.`];
  while (!full && shown.activity.length && printed(shown, dropped ? sizeNote() : notes) > STEP_REPLY_MAX) {
    dropped += 1;
    shown = { ...view, activity: view.activity.slice(dropped) };
  }
  return reply(shown, { notes: dropped ? sizeNote() : notes, next });
}
