// `sous check`: what can be known about a workflow without running it. The script parses, the
// inputs given fit what it declares, and each workflow, agent, MCP server and script file it
// names exists. It reads the names from the parsed script. Names built at run time can't be
// checked, so it reads strings written in the script only.
// A step that names an agent and a harness must be able to run that agent there. A room's options
// must be ones room() takes, as far as the text shows them.

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  HARNESSES,
  harnessName,
  isHarness,
  lookupAgents,
  lookupMcpServers,
  lookupSettings,
  missingServer,
  planStep,
  removedHarness,
  routeHarness,
  type McpLookup,
} from "../agents.js";
import type { HarnessId } from "@sous-run/harnesses";
import { nextRun, parseCron } from "../runs/cron.js";
import { loadConfig, loadSecrets, type HomePaths } from "../runs/home.js";
import { projectWorkflows, resolveWorkflow } from "./dir.js";
import { checkInputs } from "./meta.js";
import { ROOM_KEYS, ROOM_TURNS, SAYS } from "../room/options.js";
import { readWorkflowScript, type RoomRef, type ScriptRefs, type Seen } from "./script.js";

export interface CheckResult {
  workflow: string;
  file: string;
  description?: string;
  inputs: Record<string, unknown>;
  problems: string[];
  notes: string[];
}

export function checkWorkflow(paths: HomePaths, projectDir: string, nameOrPath: string, given?: Record<string, unknown>): CheckResult {
  const resolved = resolveWorkflow(paths, projectDir, nameOrPath);
  const problems: string[] = [];
  const notes: string[] = [];
  const dirs = projectWorkflows(paths, projectDir);
  const settings = lookupSettings(paths, projectDir);
  const agents = lookupAgents(settings);
  let mcp: McpLookup | undefined;
  try {
    mcp = lookupMcpServers(settings, { ...process.env, ...loadSecrets(paths) });
  } catch (error) {
    problems.push((error as Error).message);
  }
  const checkServers = (names: string[], harness: HarnessId, within: string) => {
    for (const name of names) if (mcp && !mcp.find(name, harness)) problems.push(`${within}${missingServer(name, harness, mcp)}`);
  };

  // A default harness or model sous no longer runs would send steps to Claude Code without a word.
  const config = loadConfig(paths);
  if (config.defaultHarness !== undefined && !isHarness(config.defaultHarness)) {
    problems.push(`the configured default harness "${config.defaultHarness}" is not one sous runs. Use one of ${HARNESSES.join(", ")}.`);
  }
  const defaultModel = removedHarness(config.defaultModel);
  if (defaultModel) problems.push(`the configured default ${defaultModel}`);
  problems.push(...(resolved.extras.metaProblems ?? []));
  if (given) {
    problems.push(...checkInputs(resolved.extras, given).problems);
  }

  const seen = new Set<string>();
  const visit = (name: string, refs: ScriptRefs, depth: number) => {
    if (seen.has(name)) return;
    seen.add(name);
    const where = name === resolved.name ? "" : ` (in ${name})`;
    const within = name === resolved.name ? "" : `in ${name}: `;
    if (depth > 5) {
      problems.push(`workflows nest more than 5 levels deep${where}`);
      return;
    }
    for (const child of refs.workflows) {
      const text = dirs.resolve(child);
      if (text === undefined) {
        problems.push(`no saved workflow "${child}"${where}`);
        continue;
      }
      let childRefs: ScriptRefs;
      try {
        childRefs = readWorkflowScript(text).refs;
      } catch (error) {
        problems.push(`workflow "${child}" does not parse: ${(error as Error).message}`);
        continue;
      }
      visit(child, childRefs, depth + 1);
    }
    for (const model of refs.models) {
      const removed = removedHarness(model);
      if (removed) problems.push(`${within}${removed}`);
    }
    // Each step's options: the agent it names, the model or harness, and its MCP servers.
    for (const step of refs.steps) {
      const { agentType, model, mcp: servers } = step;
      if (agentType) {
        const planned = planStep(agents, agentType, { ...(model ? { model } : {}), ...(servers.length ? { mcp: servers } : {}) });
        if ("problem" in planned) {
          problems.push(`${within}${planned.problem}`);
          continue;
        }
        const { plan } = planned;
        if (!model && step.setsModel && plan.agent.from !== "rulesync") {
          const from = harnessName(plan.agent.from);
          notes.push(`${within}a step with agent "${agentType}" picks its harness while running. The agent comes from ${plan.agent.file}, so the step stops on any harness but ${from}.`);
        }
        checkServers(plan.mcp ?? [], plan.harness, within);
      } else if (!step.setsAgentType) {
        checkServers(servers, routeHarness(model) ?? settings.defaultHarness, within);
      }
    }
    for (const file of refs.scripts) {
      const full = isAbsolute(file) ? file : join(projectDir, file);
      if (!existsSync(full)) notes.push(`script ${file} is not in ${projectDir}${where}. It must exist where the run works.`);
    }
    // sous sends a prompt as written, so one that starts with a value from outside could run a slash command.
    for (const { label, line } of refs.runTimePrompts) {
      const step = label === undefined ? "agent" : `agent "${label}"`;
      notes.push(`${within}${step} (line ${line}) starts its prompt with a value made at run time. A value that starts with "/" would run a command. Start the prompt with fixed words.`);
    }
    if (refs.choosesAnyWorkflow) notes.push(`an agent may pick any saved workflow${where}`);
    for (const room of refs.rooms) problems.push(...roomProblems(room).map((problem) => `${within}${problem}`));
  };
  visit(resolved.name, resolved.refs, 1);

  const extras = resolved.extras;
  if (!Object.keys(extras.inputs).length) notes.push("declares no inputs, so it takes any");
  if (extras.schedule) {
    const next = nextRun(parseCron(extras.schedule.cron));
    notes.push(`the service starts it at "${extras.schedule.cron}"${next ? `, next ${next.toLocaleString()}` : ""}, when it runs (sous daemon start)`);
  }
  return {
    workflow: resolved.name,
    file: resolved.file,
    ...(extras.description ? { description: extras.description } : {}),
    inputs: extras.inputs,
    problems: [...new Set(problems)],
    notes: [...new Set(notes)],
  };
}

const literal = (value: Seen | undefined) => (value?.t === "literal" ? value : undefined);

/** What a room() call's text shows is wrong, in the words room() uses when it starts. A value made
 *  at run time is not checked here. room() checks it before the room's first turn. */
function roomProblems(room: RoomRef): string[] {
  const found: string[] = [];
  const { options } = room;
  const props = options.t === "object" ? options.props : {};
  const name = literal(props["name"]);
  const named = typeof name?.value === "string" && name.value.trim() ? ` "${name.value.trim()}"` : "";
  const say = (problem: string) => found.push(`room${named} (line ${room.line}): ${problem}`);
  if (options.t === "literal" || options.t === "list" || options.t === "handle" || options.t === "other") say(SAYS.options);
  if (options.t !== "object") return found;
  const has = (key: string) => props[key] !== undefined || options.open;
  for (const key of Object.keys(props)) if (!(ROOM_KEYS as readonly string[]).includes(key)) say(SAYS.key(key));
  const goal = literal(props["goal"]);
  if (!has("goal") || (goal && (typeof goal.value !== "string" || !goal.value.trim()))) say(SAYS.goal);
  if (!has("members")) say(SAYS.members);
  if (name && (typeof name.value !== "string" || !name.value.trim())) say(SAYS.name);
  const turns = literal(props["turns"]);
  if (turns && !ROOM_TURNS.includes(turns.value as never)) say(SAYS.turns(turns.value));
  const hears = literal(props["hears"]);
  if (hears && hears.value !== "all" && hears.value !== "addressed") say(SAYS.hears(hears.value));
  const maxRounds = literal(props["maxRounds"]);
  if (maxRounds && (typeof maxRounds.value !== "number" || !Number.isInteger(maxRounds.value) || maxRounds.value < 1)) say(SAYS.maxRounds(maxRounds.value));
  const schema = props["schema"];
  if (schema?.t === "literal" || schema?.t === "list" || schema?.t === "handle") say(SAYS.schema);
  if (props["decider"] === undefined && !options.open) {
    if (turns?.value === "moderated") say(SAYS.moderated);
    if (schema !== undefined) say(SAYS.schemaDecider);
  }
  const labels = members(props["members"], say);
  const decider = props["decider"];
  const handles = labels?.map((member) => member.at);
  if (decider && decider.t !== "unknown" && (decider.t !== "handle" || (handles && !handles.includes(decider.at)))) say(SAYS.decider);
  opening(props["opening"], labels?.map((member) => member.label), say);
  return found;
}

/** Checks the members the text writes. Gives each member's handle and label when the text shows
 *  them all, else undefined. */
function members(value: Seen | undefined, say: (problem: string) => void): Array<{ at: number; label: string | undefined }> | undefined {
  if (value === undefined || value.t === "unknown") return undefined;
  if (value.t !== "list" || (!value.open && value.items.length < 2)) {
    say(SAYS.members);
    return undefined;
  }
  const known: Array<{ at: number; label: string | undefined }> = [];
  value.items.forEach((item, index) => {
    if (item.t === "handle") known.push({ at: item.at, label: item.label });
    else if (item.t === "object") {
      const { session, role, ...rest } = item.props;
      if (Object.keys(rest).length) say(SAYS.memberKeys(index, Object.keys(rest)));
      if (session?.t === "handle") known.push({ at: session.at, label: session.label });
      else if (session === undefined ? !item.open : session.t !== "unknown") say(SAYS.session(index));
      const line = literal(role);
      if (line && (typeof line.value !== "string" || !line.value.trim())) say(SAYS.role(index));
    } else if (item.t !== "unknown") say(SAYS.member(index));
  });
  const labels = new Set<string>();
  for (const { label } of known) {
    if (label === "all") say(SAYS.all);
    else if (label !== undefined && labels.has(label)) say(SAYS.twice(label));
    if (label !== undefined) labels.add(label);
  }
  return !value.open && known.length === value.items.length ? known : undefined;
}

/** Checks the opening messages the text writes. A label is checked only when the text shows every member's. */
function opening(value: Seen | undefined, labels: Array<string | undefined> | undefined, say: (problem: string) => void): void {
  if (value === undefined || value.t === "unknown") return;
  if (value.t !== "list") return void say(SAYS.opening);
  const all = labels?.every((label) => label !== undefined) ? new Set(labels as string[]) : undefined;
  value.items.forEach((item, index) => {
    if (item.t === "unknown") return;
    if (item.t !== "object") return void say(SAYS.message(index));
    const { from, to, text, ...rest } = item.props;
    if (Object.keys(rest).length) say(SAYS.messageKeys(index, Object.keys(rest)));
    const [sender, receiver, words] = [literal(from), literal(to), literal(text)];
    if (sender && (typeof sender.value !== "string" || (all && !all.has(sender.value)))) say(SAYS.from(index, sender.value));
    if (receiver && (typeof receiver.value !== "string" || (all && receiver.value !== "all" && !all.has(receiver.value)))) say(SAYS.to(index, receiver.value));
    if (sender && receiver && sender.value === receiver.value) say(SAYS.self(index, String(sender.value)));
    if (words && typeof words.value !== "string") say(SAYS.text(index, words.value));
  });
}
