// sous serve: the page of the runs in the browser, on this machine only. It prints a link that
// holds a token, opens it, and serves until Ctrl-C. It is the person's: a step of a run never
// starts it, and an agent starts it only with --by person.

import { Refusal } from "@sous-run/engine";
import { str, Usage, type Parsed } from "../args.js";
import { reply, type Reply } from "../reply.js";
import { startServer } from "../serve/server.js";
import { projectDir } from "./common.js";
import type { CommandSpec, Ctx } from "./index.js";

/** The port sous serve tries first. */
const PORT = 4317;

function portOf(args: Parsed): number {
  const text = str(args.flags.port);
  if (text === undefined) return PORT;
  const port = Number(text);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Usage(`--port takes a port from 0 to 65535, got "${text}"`, "bad_argument", "Give a free port, or 0 for any free one.", "sous serve --port 4317");
  return port;
}

export async function cmdServe(args: Parsed, ctx: Ctx, commands: Record<string, CommandSpec>): Promise<Reply<object>> {
  const { who, machine } = ctx;
  if (who.through.kind === "run") {
    const message = `a step of run ${who.through.runId} has no person to read the page, so it can't start sous serve.`;
    throw new Refusal("no_person_here", message, "Leave sous serve to the person, in their own terminal.", null);
  }
  if (who.by !== "person") {
    const message = "sous serve opens a page for the person, so an agent starts it only when the person asked for it.";
    throw new Refusal("needs_person", message, "Ask the person first. Once they asked for the page, add --by person.", `${ctx.command} --by person`);
  }
  const served = await startServer({
    paths: ctx.paths,
    project: projectDir(args),
    port: portOf(args),
    host: "127.0.0.1",
    ...(ctx.env.SOUS_SERVE_TOKEN ? { token: ctx.env.SOUS_SERVE_TOKEN } : {}),
    launch: (...launched) => ctx.launch(...launched),
    commands,
    env: ctx.env,
    log: (line) => machine.err(line),
  });
  machine.out(`sous serve: ${served.url}`);
  machine.out(`Open the link to see the runs of ${ctx.paths.home}. Ctrl-C stops the server.`);
  if (args.flags["no-open"] !== true && machine.isTerminal) machine.open(served.url);
  await machine.untilStopped();
  await served.close();
  return reply({}, { text: ["sous serve stopped."] });
}
