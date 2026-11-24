// sous workflows, workflows show, workflows approve, agents and check: the saved workflows and the
// agents their steps name.

import { resolve } from "node:path";
import { approveCall, approveWorkflows, checkWorkflow, dryRun, isRequired, listAgents, projectWorkflows, rememberProject, word, workflowDiff, workflowOutline, type Answers, type InputSpec, type OutlineApproval, type Who, type WorkflowOutline } from "@sous/engine";
import { RESERVED, str, Usage, type Parsed } from "../args.js";
import { reply, type Next, type Reply } from "../reply.js";
import { atProject, projectDir } from "./common.js";
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
    for (const [name, spec] of Object.entries(extras.inputs)) out(inputLine(name, spec));
  }
  return reply({}, { text });
}

/** One input as the text forms print it. A sous flag of the same name takes the place of the
 *  input before --, so the input goes after it. */
function inputLine(name: string, spec: InputSpec): string {
  const bits = [spec.type ?? "string", isRequired(spec) ? "required" : "optional"];
  if (spec.default !== undefined) bits.push(`default ${JSON.stringify(spec.default)}`);
  return `  ${RESERVED.includes(name) ? "-- " : ""}--${name}  ${bits.join(", ")}${spec.description ? `  ${spec.description}` : ""}`;
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
 * people workflow gives an agent no run, and nor does one that starts a saved workflow with no
 * yes: the show of that one's diff takes the run's place. Each call keeps the command's --project.
 */
function workflowNext(args: Parsed, who: Who, target: string, approved: OutlineApproval | null, outline?: Pick<WorkflowOutline, "inputs" | "startedBy" | "name"> & { waitsOn: string[] }): { next: Next[]; notes: string[] } {
  const at = (call: string) => atProject(call, str(args.flags.project));
  const name = word(target);
  const check: Next = { call: at(`sous check ${name} --json`), does: "check the workflow without running it: its inputs, agents, MCP servers and nested workflows" };
  const waitsOn = outline?.waitsOn ?? [];
  const notes = waitsOn.length ? [waitsNote(outline!.name, waitsOn)] : [];
  const shows: Next[] = waitsOn.map((inner) => ({ call: at(`sous workflows show ${word(inner)} --diff --json`), does: `what changed in ${inner} since the person's yes, to show them before they approve it` }));
  if (!approved || approved.changedSince) {
    const approve: Next = { call: at(approveCall(target)), does: "record the person's yes to this text, once they read the diff and agreed" };
    return { next: [check, approve, ...shows], notes };
  }
  if (!outline) return { next: [{ call: at(`sous workflows show ${name} --json`), does: "the workflow's outline, with the run call and its inputs" }, check], notes };
  if (outline.startedBy === "people" && who.through.kind !== "person") {
    return { next: [check], notes: [...notes, `Only a person starts ${outline.name}. Its meta says startedBy: "people".`] };
  }
  if (shows.length) return { next: [...shows, check], notes };
  const inputs = Object.entries(outline.inputs).filter(([, spec]) => isRequired(spec)).map(([input]) => input);
  const before = inputs.filter((input) => !RESERVED.includes(input)).map((input) => `--${input} <${input}>`);
  const after = inputs.filter((input) => RESERVED.includes(input)).map((input) => `--${input} <${input}>`);
  const words = [`sous run ${name}`, ...before, "--json"];
  const run: Next = { call: `${at(words.join(" "))}${after.length ? ` -- ${after.join(" ")}` : ""}`, does: inputs.length ? "start a run, with each input's value in place of <...>" : "start a run" };
  return { next: [run, check], notes };
}

/** The note for a workflow that starts saved workflows with no yes for their text. */
function waitsNote(name: string, waitsOn: string[]): string {
  const list = waitsOn.length > 1 ? `${waitsOn.slice(0, -1).join(", ")} and ${waitsOn.at(-1)}` : waitsOn[0]!;
  const them = waitsOn.length > 1 ? "them" : "it";
  return `${name} starts ${list}, new or changed since the person approved ${them}. An agent's run of ${name} is refused until the person approves ${them} too.`;
}

/** sous workflows show <name|path> [--diff] [--full]: one workflow's outline, or what changed since the person's yes. */
function cmdShowWorkflow(args: Parsed, ctx: Ctx): Reply<object> {
  const target = args.positional[1];
  if (!target || args.positional.length > 2) throw new Usage("sous workflows show <name or path> [--diff] [--full]");
  if (args.flags.diff === true) return showDiff(args, ctx, target);
  const { target: approveAs, waitsOn, ...outline } = workflowOutline(ctx.paths, projectDir(args), target, ctx.now());
  const { next, notes } = workflowNext(args, ctx.who, approveAs, outline.approved, { ...outline, waitsOn });
  notes.unshift(STEPS_NOTE);
  const shown = args.flags.full === true ? { outline, notes } : fitOutline(outline, notes, next, word(approveAs));
  return reply(shown.outline, { notes: shown.notes, next, text: outlineText(shown.outline) });
}

/** How many of the outline's lists it shows: its steps, and the check's notes and problems. */
interface Kept {
  steps: number;
  notes: number;
  problems: number;
}

/** The largest count from 0 to `total` that fits, or 0 when none does. Fewer always fit as well. */
function most(total: number, fits: (count: number) => boolean): number {
  let low = 0;
  let high = total;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * The outline under OUTLINE_MAX characters. It cuts the steps first, then the check's notes, then
 * its problems, and says what it left out in a note that names --full.
 */
function fitOutline(outline: WorkflowOutline, notes: string[], next: Next[], name: string): { outline: WorkflowOutline; notes: string[] } {
  const max = OUTLINE_MAX.toLocaleString("en-US");
  const { steps, check } = outline;
  const cut = (kept: Kept) => {
    const shown = { ...outline, steps: steps.slice(0, kept.steps), check: { problems: check.problems.slice(0, kept.problems), notes: check.notes.slice(0, kept.notes) } };
    const more: string[] = [];
    if (kept.steps < steps.length) more.push(`${steps.length - kept.steps} more steps not shown, to keep the reply under ${max} characters. Add --full to see them all.`);
    const left = check.notes.length - kept.notes + check.problems.length - kept.problems;
    if (left) more.push(`${left} more of the check's problems and notes not shown, to keep the reply under ${max} characters. Add --full, or run sous check ${name} --json, to see them all.`);
    return { outline: shown, notes: [...notes, ...more] };
  };
  const fits = (kept: Kept) => {
    const shown = cut(kept);
    return JSON.stringify({ ...shown.outline, notes: shown.notes, next }, null, 2).length + 1 < OUTLINE_MAX;
  };
  const kept: Kept = { steps: steps.length, notes: check.notes.length, problems: check.problems.length };
  if (fits(kept)) return { outline, notes };
  kept.steps = most(steps.length, (count) => fits({ ...kept, steps: count }));
  if (!fits(kept)) kept.notes = most(check.notes.length, (count) => fits({ ...kept, notes: count }));
  if (!fits(kept)) kept.problems = most(check.problems.length, (count) => fits({ ...kept, problems: count }));
  return cut(kept);
}

function outlineText(outline: WorkflowOutline): string[] {
  const text = [`${outline.name}  ${outline.file}  (${outline.from})`];
  if (outline.description) text.push(`  ${outline.description}`);
  for (const [name, spec] of Object.entries(outline.inputs)) text.push(inputLine(name, spec));
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

/**
 * The changed lines, each with CONTEXT matching lines around it, and an "@@ line N @@" line where
 * matching lines are left out, N being the line of the file the next part starts at. No change
 * gives no line.
 */
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
  const out: string[] = [];
  // The line of the file each diff line stands at: a "- " line is not in the file, so it does not count.
  let line = 1;
  let skipped = false;
  for (let i = 0; i < lines.length; i++) {
    if (near[i]! > CONTEXT) skipped = true;
    else {
      if (skipped) out.push(`@@ line ${line} @@`);
      skipped = false;
      out.push(lines[i]!);
    }
    if (!lines[i]!.startsWith("- ")) line++;
  }
  return out;
}

/** sous workflows show <name> --diff: the file against the text of the person's yes. */
function showDiff(args: Parsed, ctx: Ctx, target: string): Reply<object> {
  const { target: approveAs, approvedTextGone, tooLong, diff: all, ...shown } = workflowDiff(ctx.paths, projectDir(args), target);
  const { approved, name, file } = shown;
  const kept = aroundChanges(all);
  const notes: string[] = [];
  if (approved && !approved.changedSince) notes.push(`${name} is approved as it is. Nothing changed since the person's yes.`);
  else if (approvedTextGone) notes.push(`sous no longer has the text the person approved at ${approved!.at}, so the diff shows the whole file.`);
  else if (!approved) notes.push(`${name} has no approval yet, so the diff shows the whole file.`);
  else notes.push(`The diff compares the file with the text the person approved at ${approved.at}.`);
  if (approved?.changedSince && !approvedTextGone && !kept.length) {
    notes.push("The file differs from the approved text only where the diff shows no line, such as its final newline.");
  }
  if (tooLong) notes.push("The changed part is too long to match line by line, so the diff gives all of its old lines, then all of its new ones.");
  if (kept.length && kept.length < all.length) notes.push(`The diff keeps ${CONTEXT} matching lines around each change. An "@@ line N @@" line stands for the matching lines left out, and N is the line of the file after it.`);
  const diff = kept.slice(0, DIFF_LINES);
  if (kept.length > DIFF_LINES) notes.push(`The diff is cut at ${DIFF_LINES} of its ${kept.length} lines. Read ${file} for the rest.`);
  if (!approved || approved.changedSince) notes.push("Show the person this diff and ask them. Make the approve call only once they agree.");
  if (args.flags.full === true) notes.push(`--full changes nothing with --diff. Read ${file} for the whole file.`);
  const calls = workflowNext(args, ctx.who, approveAs, approved);
  return reply({ ...shown, diff }, { notes: [...notes, ...calls.notes], next: calls.next, text: diff });
}

/** sous agents: the agents a step of this project can name, from its folders and the home's. */
export function cmdAgents(args: Parsed, ctx: Ctx): Reply<object> {
  const { agents, problems } = listAgents(ctx.paths, projectDir(args), ctx.env);
  const notes = agents.length
    ? ['A step names an agent with agentType, such as agent("...", { agentType: "name" }).']
    : ["No agent found. sous reads .rulesync/subagents, .claude/agents and .codex/agents in the project, then the home's."];
  for (const problem of problems) notes.push(`A step can't use the agent ${problem.name}: ${problem.message}`);
  if (args.positional.length) notes.push(`sous agents takes no name, so it left out ${args.positional.join(" ")} and lists them all.`);
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
