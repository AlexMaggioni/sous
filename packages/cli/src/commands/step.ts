// sous step: one step of a run, with what it did.

import { stepView, type StepView } from "@sous/engine";
import { Usage, type Parsed } from "../args.js";
import { reply, type Next, type Reply } from "../reply.js";
import { runIdArg, wholeFlag } from "./common.js";
import type { Ctx } from "./index.js";
import { stepNext } from "./next.js";

/** How long the printed reply of sous step --json may be, as every JSON reply. */
const STEP_REPLY_MAX = 8000;

type Shown = Omit<StepView, "earlier" | "promptCut" | "alsoIn">;

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};

/** The step as lines a person reads. */
function stepText(view: Shown): string[] {
  const time = [view.seconds === undefined ? "" : `${view.seconds}s`, view.tokens ? `${view.tokens} tokens` : ""].filter(Boolean).join(", ");
  const where = view.scope === view.runId ? `run ${view.runId}` : `nested run ${view.scope}`;
  const lines = [`step ${view.step} of ${where}, call ${view.call} of ${view.calls}: ${view.status} (${view.kind}${view.model ? ` ${view.model}` : ""}${time ? `, ${time}` : ""})`];
  if (view.command !== undefined) lines.push(`command: ${view.command}`);
  if (view.prompt !== undefined) lines.push(`prompt: ${oneLine(view.prompt, 200)}`);
  if (view.failure !== undefined) lines.push(`failure: ${view.failure}`);
  if (view.activity.length) lines.push("activity:");
  for (const line of view.activity) lines.push(`  ${line.at.slice(11, 19)} ${line.kind.padEnd(11)} ${line.tool ? `${line.tool}: ` : ""}${oneLine(line.text, 300)}`);
  return lines;
}

/** The most of the failure and the command a reply keeps when they alone pass STEP_REPLY_MAX. */
const LONG_TEXT = 1_000;

/** The characters an activity entry adds to the printed reply: its lines, indented in the array, and the comma. */
const entrySize = (entry: unknown) => `    ${JSON.stringify(entry, null, 2).split("\n").join("\n    ")}`.length + 2;

/**
 * The view as the JSON reply holds it, under STEP_REPLY_MAX characters: the oldest entries go
 * first, each measured once, and then the failure and the command are cut. --full keeps it all.
 */
function fitted(view: Shown, notes: string[], next: Next[], earlier: number, full: boolean): { shown: Shown; notes: string[] } {
  const printed = (shown: Shown, more: string[]) => JSON.stringify({ ...shown, notes: more, next }, null, 2).length;
  const leftOut = (count: number) =>
    count > earlier
      ? `${count} older activity entries are not shown, to keep the reply under 8,000 characters. Add --full to see them all.`
      : `${count} older activity entries are not shown. Add --tail ${count + view.activity.length} to see them.`;
  const withNote = (count: number) => (count ? [leftOut(count), ...notes] : notes);
  if (full || printed(view, withNote(earlier)) <= STEP_REPLY_MAX) return { shown: view, notes: withNote(earlier) };
  // The total with the longest note the cut can give, less each entry dropped.
  let total = printed(view, withNote(earlier + view.activity.length));
  let dropped = 0;
  while (dropped < view.activity.length && total > STEP_REPLY_MAX) total -= entrySize(view.activity[dropped++]);
  let shown: Shown = { ...view, activity: view.activity.slice(dropped) };
  const more = withNote(earlier + dropped);
  if (printed(shown, more) <= STEP_REPLY_MAX) return { shown, notes: more };
  const cut = (text: string | undefined) => (text !== undefined && text.length > LONG_TEXT ? `${text.slice(0, LONG_TEXT - 3)}...` : text);
  const failure = cut(shown.failure);
  const command = cut(shown.command);
  shown = { ...shown, ...(failure === undefined ? {} : { failure }), ...(command === undefined ? {} : { command }) };
  return { shown, notes: [...more, `The failure and the command are cut to ${LONG_TEXT.toLocaleString("en-US")} characters, to keep the reply under 8,000. Add --full to see them.`] };
}

export function cmdStep(args: Parsed, ctx: Ctx): Reply<object> {
  const id = runIdArg(args.positional[0]);
  const label = args.positional[1];
  if (!label) throw new Usage("give the step's label after the run id, such as sous step <run> <label>", "bad_argument", undefined, `sous show ${id} --json`);
  const call = wholeFlag(args, "call", 1);
  const tail = wholeFlag(args, "tail", 0);
  const full = args.flags.full === true;
  const { earlier = 0, promptCut, alsoIn, ...view } = stepView(ctx.paths, id, label, { ...(call === undefined ? {} : { call }), ...(tail === undefined ? {} : { tail }), full });
  const notes: string[] = [];
  if (promptCut) notes.push("The prompt is cut to 2,000 characters. Add --full to see all of it.");
  if (view.calls > 1 && call === undefined) notes.push(`This is the last of ${view.calls} calls. Add --call n to see another.`);
  if (alsoIn?.length) {
    const here = view.scope === view.runId ? "the run itself" : `nested run ${view.scope}`;
    notes.push(`${alsoIn.length === 1 ? "Nested run" : "Nested runs"} ${alsoIn.join(", ")} ${alsoIn.length === 1 ? "also has" : "also have"} a step "${label}". This is the one in ${here}.`);
  }
  const next = stepNext(view.runId, view.step, view.status);
  if (!ctx.json) return reply(view, { notes: earlier ? [`${earlier} older activity entries are not shown. Add --tail ${earlier + view.activity.length} to see them.`, ...notes] : notes, next, text: stepText(view) });
  const fit = fitted(view, notes, next, earlier, full);
  return reply(fit.shown, { notes: fit.notes, next });
}
