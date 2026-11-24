// sous account and doctor: the logins and programs the steps run on.

import { cmdAccount as accountCommand } from "../account-cli.js";
import { str, Usage, type Parsed } from "../args.js";
import { doctor } from "../doctor.js";
import { reply, type Reply } from "../reply.js";
import type { Ctx } from "./index.js";

/** account-cli.ts and doctor.ts print as they go and give an exit code, or give a reply with --json.
 *  Tests call them on their own, so the command turns the code into a reply here. */
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
