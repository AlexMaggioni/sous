// sous workflows, workflows show, workflows approve, agents and check: the saved workflows and the
// agents their steps name.

import { resolve } from "node:path";
import { approveCall, approveWorkflows, checkWorkflow, dryRun, listAgents, projectWorkflows, rememberProject, workflowDiff, workflowOutline, type Answers, type Who } from "@sous/engine";
import { RESERVED, str, Usage, type Parsed } from "../args.js";
import { reply, type Next, type Reply } from "../reply.js";
import { atProject, projectDir, shellWord } from "./common.js";
import type { Ctx } from "./index.js";

export function cmdWorkflows(args: Parsed, ctx: Ctx): Reply<object> {
  if (args.positional[0] === "approve") return cmdApprove(args, ctx);
  if (args.positional[0] === "show") return cmdShowWorkflow(args, ctx);
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

type Outline = ReturnType<typeof workflowOutline>;
type Approved = Outline["approved"];

/** The most characters an outline prints, as every read. */
const OUTLINE_MAX = 8000;
/** The most lines a diff gives. */
const DIFF_LINES = 200;
/** The matching lines a diff keeps before and after each change. */
const CONTEXT = 3;

const STEPS_NOTE = "steps lists the steps in the order the file writes them. A loop or a branch shows its steps once. A dry run of sous check shows the order a run takes.";

/**
 * The calls that work now on a workflow. A new or changed text gives the check and the approve
 * call, since an agent's run of it is refused. An approved one gives the run and the check. A
 * people workflow gives an agent no run. Each call keeps the command's --project.
 */
function workflowNext(args: Parsed, who: Who, target: string, approved: Approved, outline?: Pick<Outline, "inputs" | "startedBy" | "name">): { next: Next[]; notes: string[] } {
  const at = (call: string) => atProject(call, str(args.flags.project));
  const name = shellWord(target);
  const check: Next = { call: at(`sous check ${name} --json`), does: "check the workflow without running it: its inputs, agents, MCP servers and nested workflows" };
  if (!approved || approved.changedSince) {
    const approve: Next = { call: at(approveCall(target)), does: "record the person's yes to this text, once they read the diff and agreed" };
    return { next: [check, approve], notes: [] };
  }
  if (!outline) return { next: [{ call: at(`sous workflows show ${name} --json`), does: "the workflow's outline, with the run call and its inputs" }, check], notes: [] };
  if (outline.startedBy === "people" && who.through.kind !== "person") {
    return { next: [check], notes: [`Only a person starts ${outline.name}. Its meta says startedBy: "people".`] };
  }
  const inputs = Object.entries(outline.inputs).filter(([, spec]) => spec.required !== false && spec.default === undefined).map(([input]) => input);
  const before = inputs.filter((input) => !RESERVED.includes(input)).map((input) => `--${input} <${input}>`);
  const after = inputs.filter((input) => RESERVED.includes(input)).map((input) => `--${input} <${input}>`);
  const words = [`sous run ${name}`, ...before, "--json"];
  const run: Next = { call: `${at(words.join(" "))}${after.length ? ` -- ${after.join(" ")}` : ""}`, does: inputs.length ? "start a run, with each input's value in place of <...>" : "start a run" };
  return { next: [run, check], notes: [] };
}

/** sous workflows show <name|path> [--diff] [--full]: one workflow's outline, or what changed since the person's yes. */
function cmdShowWorkflow(args: Parsed, ctx: Ctx): Reply<object> {
  const target = args.positional[1];
  if (!target || args.positional.length > 2) throw new Usage("sous workflows show <name or path> [--diff] [--full]");
  if (args.flags.diff === true) return showDiff(args, ctx, target);
  const { target: approveAs, ...outline } = workflowOutline(ctx.paths, projectDir(args), target, ctx.now());
  const { next, notes } = workflowNext(args, ctx.who, approveAs, outline.approved, outline);
  notes.unshift(STEPS_NOTE);
  const shown = args.flags.full === true ? { outline, notes } : fitOutline(outline, notes, next);
  return reply(shown.outline, { notes: shown.notes, next, text: outlineText(shown.outline) });
}

/** The outline with as many steps as fit under OUTLINE_MAX, and a note naming --full when some are cut. */
function fitOutline(outline: Omit<Outline, "target">, notes: string[], next: Next[]): { outline: Omit<Outline, "target">; notes: string[] } {
  const total = outline.steps.length;
  const cutNote = (kept: number) => `${total - kept} more steps not shown, to keep the reply under 8,000 characters. Add --full to see them all.`;
  const fits = (kept: number) => {
    const withNotes = kept === total ? notes : [...notes, cutNote(kept)];
    return JSON.stringify({ ...outline, steps: outline.steps.slice(0, kept), notes: withNotes, next }, null, 2).length + 1 < OUTLINE_MAX;
  };
  if (fits(total)) return { outline, notes };
  let low = 0;
  let high = total - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return { outline: { ...outline, steps: outline.steps.slice(0, low) }, notes: [...notes, cutNote(low)] };
}

function outlineText(outline: Omit<Outline, "target">): string[] {
  const text = [`${outline.name}  ${outline.file}  (${outline.from})`];
  if (outline.description) text.push(`  ${outline.description}`);
  for (const [name, spec] of Object.entries(outline.inputs)) {
    const required = spec.required === false || spec.default !== undefined ? "optional" : "required";
    text.push(`  ${RESERVED.includes(name) ? "-- " : ""}--${name}  ${spec.type ?? "string"}, ${required}${spec.description ? `  ${spec.description}` : ""}`);
  }
  text.push("steps:");
  for (const step of outline.steps) {
    const bits = [step.agent && `agent ${step.agent}`, step.model, step.keepsSession && "keeps its session", step.workflow && `starts ${step.workflow}`, step.title && JSON.stringify(step.title)].filter(Boolean);
    text.push(`  ${step.kind}${step.step ? `  ${step.step}` : ""}${bits.length ? `  (${bits.join(", ")})` : ""}`);
  }
  const { approved } = outline;
  text.push(approved ? `approved by ${approved.by}${approved.seeded ? " (seeded)" : ""} at ${approved.at}${approved.changedSince ? ", changed since" : ""}` : "not approved yet");
  for (const run of outline.lastRuns) text.push(`run ${run.runId}  ${run.status}  ${run.seconds}s  ${run.tokens} tokens`);
  for (const problem of outline.check.problems) text.push(`problem: ${problem}`);
  return text;
}

/** The changed lines, each with CONTEXT matching lines around it. No change gives no line. */
function aroundChanges(lines: string[]): string[] {
  const near = lines.map(() => Number.POSITIVE_INFINITY);
  let last = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.startsWith("  ")) last = i;
    near[i] = i - last;
  }
  last = Number.POSITIVE_INFINITY;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.startsWith("  ")) last = i;
    near[i] = Math.min(near[i]!, last - i);
  }
  return lines.filter((_, i) => near[i]! <= CONTEXT);
}

/** sous workflows show <name> --diff: the file against the text of the person's yes. */
function showDiff(args: Parsed, ctx: Ctx, target: string): Reply<object> {
  const { target: approveAs, approvedTextGone, diff: all, ...shown } = workflowDiff(ctx.paths, projectDir(args), target);
  const { approved, name, file } = shown;
  const kept = aroundChanges(all);
  const notes: string[] = [];
  if (approved && !approved.changedSince) notes.push(`${name} is approved as it is. Nothing changed since the person's yes.`);
  else if (approvedTextGone) notes.push(`sous no longer has the text the person approved at ${approved!.at}, so the diff shows the whole file.`);
  else if (!approved) notes.push(`${name} has no approval yet, so the diff shows the whole file.`);
  else notes.push(`The diff compares the file with the text the person approved at ${approved.at}.`);
  if (kept.length && kept.length < all.length) notes.push(`The diff keeps ${CONTEXT} matching lines around each change and leaves the other matching lines out.`);
  const diff = kept.slice(0, DIFF_LINES);
  if (kept.length > DIFF_LINES) notes.push(`The diff is cut at ${DIFF_LINES} of its ${kept.length} lines. Read ${file} for the rest.`);
  if (!approved || approved.changedSince) notes.push("Show the person this diff and ask them. Make the approve call only once they agree.");
  const calls = workflowNext(args, ctx.who, approveAs, approved);
  return reply({ ...shown, diff }, { notes: [...notes, ...calls.notes], next: calls.next, text: diff });
}

/** sous agents: the agents a step of this project can name, from its folders and the home's. */
export function cmdAgents(args: Parsed, ctx: Ctx): Reply<object> {
  const agents = listAgents(ctx.paths, projectDir(args), ctx.env);
  const notes = agents.length
    ? ['A step names an agent with agentType, such as agent("...", { agentType: "name" }).']
    : ["No agent found. sous reads .rulesync/subagents, .claude/agents and .codex/agents in the project, then the home's."];
  const text = agents.map((agent) => `${agent.name}  ${agent.harness}${agent.model ? `  ${agent.model}` : ""}${agent.description ? `  ${agent.description}` : ""}\n  ${agent.file}`);
  return reply({ agents }, { notes, text });
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
