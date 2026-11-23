// `orc check`: what can be known about a workflow without running it. The script parses, the
// inputs given fit what it declares, and each workflow, agent, MCP server and script file it
// names exists. It reads the names from the parsed script. Names built at run time can't be
// checked, so it reads strings written in the script only.
// A step that names an agent and a harness must be able to run that agent there.

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
  type Harness,
  type McpLookup,
} from "../agents.js";
import { nextRun, parseCron } from "../runs/cron.js";
import { loadConfig, loadSecrets, type HomePaths } from "../runs/home.js";
import { projectWorkflows, resolveWorkflow } from "./dir.js";
import { checkInputs } from "./meta.js";
import { readWorkflowScript, type ScriptRefs } from "./script.js";

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
  const checkServers = (names: string[], harness: Harness, within: string) => {
    for (const name of names) if (mcp && !mcp.find(name, harness)) problems.push(`${within}${missingServer(name, harness, mcp)}`);
  };

  // A default harness or model orc no longer runs would send steps to Claude Code without a word.
  const config = loadConfig(paths);
  if (config.defaultHarness !== undefined && !isHarness(config.defaultHarness)) {
    problems.push(`the configured default harness "${config.defaultHarness}" is not one orc runs. Use one of ${HARNESSES.join(", ")}.`);
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
        checkServers(servers, routeHarness(model, settings.env) ?? settings.defaultHarness, within);
      }
    }
    for (const file of refs.scripts) {
      const full = isAbsolute(file) ? file : join(projectDir, file);
      if (!existsSync(full)) notes.push(`script ${file} is not in ${projectDir}${where}. It must exist where the run works.`);
    }
    if (refs.choosesAnyWorkflow) notes.push(`an agent may pick any saved workflow${where}`);
  };
  visit(resolved.name, resolved.refs, 1);

  const extras = resolved.extras;
  if (!Object.keys(extras.inputs).length) notes.push("declares no inputs, so it takes any");
  if (extras.schedule) {
    const next = nextRun(parseCron(extras.schedule.cron));
    notes.push(`the service starts it at "${extras.schedule.cron}"${next ? `, next ${next.toLocaleString()}` : ""}, when it runs (orc daemon start)`);
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
