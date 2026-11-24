// sous account and doctor: the logins and programs the steps run on.

import { cmdAccount as accountCommand } from "../account-cli.js";
import { str, Usage, type Parsed } from "../args.js";
import { doctor } from "../doctor.js";
import type { Reply } from "../reply.js";
import type { Ctx } from "./index.js";

export function cmdAccount(args: Parsed, ctx: Ctx): Promise<number | Reply<object>> {
  // The workers start through ctx.launch, read only when one starts, so a listing needs no build.
  return accountCommand(args.positional, { json: ctx.json, usage: (message) => new Usage(message), launch: (...start) => ctx.launch(...start) });
}

export function cmdDoctor(args: Parsed, ctx: Ctx): Promise<number | Reply<object>> {
  return doctor({ live: args.flags.live === true, model: str(args.flags.model), json: ctx.json, out: ctx.machine.out });
}
