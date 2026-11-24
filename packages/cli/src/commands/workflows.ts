// sous workflows, workflows approve and check: the saved workflows.

import { resolve } from "node:path";
import { approveWorkflows, checkWorkflow, dryRun, projectWorkflows, rememberProject, type Answers } from "@sous/engine";
import { RESERVED, str, Usage, type Parsed } from "../args.js";
import { reply, type Reply } from "../reply.js";
import { projectDir } from "./common.js";
import type { Ctx } from "./index.js";

export function cmdWorkflows(args: Parsed, ctx: Ctx): Reply<object> {
  if (args.positional[0] === "approve") return cmdApprove(args, ctx);
  const paths = ctx.paths;
  const text: string[] = [];
  const out = (line: string) => text.push(line);
  const view = projectWorkflows(paths, projectDir(args));
  const entries = view.list();
  if (ctx.json) return reply({ workflows: entries.map((entry) => ({ name: entry.name, file: entry.file, ...(entry.error ? { error: entry.error } : { ...entry.extras }) })) });
  if (!entries.length) {
    out(`no saved workflows. Put them in ${view.dirs.join(" or ")}.`);
    return reply({}, { text });
  }
  for (const entry of entries) {
    if (entry.error) {
      out(`${entry.name}  (does not parse: ${entry.error})`);
      continue;
    }
    const extras = entry.extras!;
    out(`${entry.name}${extras.description ? `  ${extras.description}` : ""}`);
    for (const [name, spec] of Object.entries(extras.inputs)) {
      const bits = [spec.type ?? "string", spec.required === false || spec.default !== undefined ? "optional" : "required"];
      if (spec.default !== undefined) bits.push(`default ${JSON.stringify(spec.default)}`);
      // A sous flag of the same name takes the place of the input before --.
      out(`  ${RESERVED.includes(name) ? "-- " : ""}--${name}  ${bits.join(", ")}${spec.description ? `  ${spec.description}` : ""}`);
    }
  }
  return reply({}, { text });
}

/** sous workflows approve <name|path> | --all: the person's yes to the text as it is now. */
function cmdApprove(args: Parsed, ctx: Ctx): Reply<object> {
  const target = args.positional[1];
  const all = args.flags.all === true;
  if (Boolean(target) === all || args.positional.length > 2) throw new Usage("sous workflows approve <name or path> | --all [--by person]");
  const { approved, unchanged } = approveWorkflows(ctx.paths, projectDir(args), all ? undefined : target, ctx.who);
  const notes = unchanged.length && !all ? [`${unchanged[0]!.workflow} is approved as it is already.`] : [];
  if (all && !approved.length) notes.push("Every workflow is approved as it is already.");
  const text = approved.map((entry) => `approved ${entry.workflow}  ${entry.file}`);
  return reply({ approved, unchanged }, { notes, text });
}

function readAnswers(ctx: Ctx, file: string): Answers {
  const parsed: unknown = JSON.parse(ctx.machine.readText(file));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} must hold an object from step label to answer, such as {"reviewer *": {"approved": false, "review": "Add a test"}}`);
  }
  return parsed as Answers;
}

export async function cmdCheck(args: Parsed, ctx: Ctx): Promise<Reply<object>> {
  const paths = ctx.paths;
  const dir = projectDir(args);
  const out = ctx.machine.out;
  const name = args.positional[0];
  if (!name) throw new Usage("sous check <workflow> [--name value ...] [--dry-run [--answers file.json]]");
  const inputs = Object.keys(args.inputs).length ? args.inputs : undefined;
  const result = checkWorkflow(paths, dir, name, inputs);
  for (const input of Object.keys(result.inputs).filter((key) => RESERVED.includes(key))) {
    result.notes.push(`the input ${input} has the name of a sous flag, so give it after --: sous run ${name} -- --${input} value`);
  }
  // The service reads this project's workflow files for a schedule from now on.
  rememberProject(paths, dir);
  const json = ctx.json;
  const wantsDryRun = args.flags["dry-run"] === true;
  if (!json) {
    out(`${result.workflow}  ${result.file}`);
    for (const problem of result.problems) out(`  problem: ${problem}`);
    for (const note of result.notes) out(`  note: ${note}`);
    out(result.problems.length ? `${result.problems.length} problem${result.problems.length === 1 ? "" : "s"}` : "ok");
  }
  const { notes, ...checked } = result;
  if (result.problems.length || !wantsDryRun) {
    const exit = result.problems.length ? 1 : 0;
    return json ? reply(checked, { notes, exit }) : reply({}, { exit });
  }
  const answersFile = str(args.flags.answers);
  const answers = answersFile ? readAnswers(ctx, resolve(answersFile)) : undefined;
  if (!json) out("dry run with stand-in agents. Code steps run for real, never in the project folder, and what they make is deleted after.");
  const dry = await dryRun(paths, { workflow: name, projectDir: dir, inputs: args.inputs, who: ctx.who, command: ctx.command, ...(answers ? { answers } : {}), ...(json ? {} : { log: (line: string) => out(`  ${line}`) }) });
  if (json) return reply({ ...checked, dryRun: dry }, { notes, exit: dry.status === "completed" ? 0 : 1 });
  if (dry.status === "completed") {
    out(`dry run completed, with ${dry.agents.length} agent step${dry.agents.length === 1 ? "" : "s"} answered by stand-ins`);
    if (dry.result !== undefined) out(JSON.stringify(dry.result, null, 2));
  } else {
    out(`the dry run did not complete: ${dry.status}${dry.reason ? ` (${dry.reason.replace(/\s+/g, " ")})` : ""}`);
  }
  return reply({}, { exit: dry.status === "completed" ? 0 : 1 });
}
