// sous join <run> <step>: the person steps into the session of an agent step, in this terminal,
// and gives it back to the step when they leave. step-in.ts does the work.

import { joinTarget } from "@sous-run/engine";
import { Usage, type Parsed } from "../args.js";
import { reply, type Reply } from "../reply.js";
import { runIdArg, wholeFlag } from "./common.js";
import type { Ctx } from "./index.js";
import { leftText, stepIn, STOPPED_WAITING } from "./step-in.js";

export async function cmdJoin(args: Parsed, ctx: Ctx): Promise<Reply<object>> {
  const id = runIdArg(args.positional[0]);
  const step = args.positional[1];
  if (!step) throw new Usage("give the step to step into after the run id, such as sous join <run> <step>", "bad_argument", undefined, `sous show ${id} --json`);
  const call = wholeFlag(args, "call", 1);
  const target = joinTarget(ctx.paths, id, step, call === undefined ? {} : { call });
  const joined = await stepIn(ctx, target);
  if ("stopped" in joined) {
    return reply({ runId: target.runId, step: target.step, joined: false }, { text: [`stopped waiting. "${target.label}" keeps its session.`], exit: STOPPED_WAITING });
  }
  return reply(joined, leftText(joined));
}
