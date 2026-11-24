// sous workflows and check: the saved workflows.

import { resolve } from "node:path";
import { checkWorkflow, dryRun, projectWorkflows, rememberProject, type Answers } from "@sous/engine";
import { str, Usage, type Parsed } from "../args.js";
import { projectDir } from "./common.js";
import type { Ctx } from "./index.js";

export function cmdWorkflows(args: Parsed, ctx: Ctx): number {
  const paths = ctx.paths;
  const out = ctx.machine.out;
  const view = projectWorkflows(paths, projectDir(args));
  const entries = view.list();
  if (ctx.json) {
    out(JSON.stringify(entries.map((entry) => ({ name: entry.name, file: entry.file, ...(entry.error ? { error: entry.error } : { ...entry.extras }) })), null, 2));
    return 0;
  }
  if (!entries.length) {
    out(`no saved workflows. Put them in ${view.dirs.join(" or ")}.`);
    return 0;
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
      out(`  --${name}  ${bits.join(", ")}${spec.description ? `  ${spec.description}` : ""}`);
    }
  }
  return 0;
}

function readAnswers(ctx: Ctx, file: string): Answers {
  const parsed: unknown = JSON.parse(ctx.machine.readText(file));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} must hold an object from step label to answer, such as {"reviewer *": {"approved": false, "review": "Add a test"}}`);
  }
  return parsed as Answers;
}

export async function cmdCheck(args: Parsed, ctx: Ctx): Promise<number> {
  const paths = ctx.paths;
  const dir = projectDir(args);
  const out = ctx.machine.out;
  const name = args.positional[0];
  if (!name) throw new Usage("sous check <workflow> [--name value ...] [--dry-run [--answers file.json]]");
  const inputs = Object.keys(args.inputs).length ? args.inputs : undefined;
  const result = checkWorkflow(paths, dir, name, inputs);
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
  if (result.problems.length || !wantsDryRun) {
    if (json) out(JSON.stringify(result, null, 2));
    return result.problems.length ? 1 : 0;
  }
  const answersFile = str(args.flags.answers);
  const answers = answersFile ? readAnswers(ctx, resolve(answersFile)) : undefined;
  if (!json) out("dry run with stand-in agents. Code steps run for real, never in the project folder, and what they make is deleted after.");
  const dry = await dryRun(paths, { workflow: name, projectDir: dir, inputs: args.inputs, ...(answers ? { answers } : {}), ...(json ? {} : { log: (line: string) => out(`  ${line}`) }) });
  if (json) {
    out(JSON.stringify({ ...result, dryRun: dry }, null, 2));
  } else if (dry.status === "completed") {
    out(`dry run completed, with ${dry.agents.length} agent step${dry.agents.length === 1 ? "" : "s"} answered by stand-ins`);
    if (dry.result !== undefined) out(JSON.stringify(dry.result, null, 2));
  } else {
    out(`the dry run did not complete: ${dry.status}${dry.reason ? ` (${dry.reason.replace(/\s+/g, " ")})` : ""}`);
  }
  return dry.status === "completed" ? 0 : 1;
}
