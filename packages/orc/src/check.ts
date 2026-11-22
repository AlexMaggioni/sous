// `orc check`: what can be known about a workflow without running it. The script parses, the
// inputs given fit what it declares, and each workflow, agent, MCP server and script file it
// names exists. Names built at run time can't be checked, so the check reads literals only.
// A step that names an agent and a harness must be able to run that agent there.

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  checkInputs,
  HARNESSES,
  harnessName,
  isHarness,
  loadConfig,
  loadSecrets,
  lookupAgents,
  lookupMcpServers,
  lookupSettings,
  missingServer,
  nextRun,
  openWorkflowDir,
  parseCron,
  parseWorkflowScript,
  planStep,
  removedHarness,
  resolveWorkflow,
  routeHarness,
  workflowDirs,
  type Harness,
  type HomePaths,
  type McpLookup,
} from "@orchestrator/engine";

export interface CheckResult {
  workflow: string;
  file: string;
  description?: string;
  inputs: Record<string, unknown>;
  problems: string[];
  notes: string[];
}

function literals(script: string, pattern: RegExp): string[] {
  const out = new Set<string>();
  for (const match of script.matchAll(pattern)) out.add(match[2]!);
  return [...out];
}

function stringList(script: string, key: string): string[] {
  const out = new Set<string>();
  const pattern = new RegExp(`\\b${key}\\s*:\\s*\\[([^\\]]*)\\]`, "g");
  for (const match of script.matchAll(pattern)) {
    for (const item of match[1]!.matchAll(/(['"`])([^'"`]+)\1/g)) out.add(item[2]!);
  }
  return [...out];
}

/** The object literal around a position, from the nearest unclosed "{" before it to its "}". */
function enclosingObject(script: string, at: number): { start: number; text: string } | undefined {
  let depth = 0;
  let start = -1;
  for (let i = at; i >= 0; i--) {
    if (script[i] === "}") depth++;
    else if (script[i] === "{") {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start < 0) return undefined;
  depth = 0;
  for (let i = start; i < script.length; i++) {
    if (script[i] === "{") depth++;
    else if (script[i] === "}" && --depth === 0) return { start, text: script.slice(start, i + 1) };
  }
  return { start, text: script.slice(start) };
}

const literal = (text: string, key: string) => new RegExp(`\\b${key}\\s*:\\s*(['"])([^'"]+)\\1`).exec(text)?.[2];

export function checkWorkflow(paths: HomePaths, projectDir: string, nameOrPath: string, given?: Record<string, unknown>): CheckResult {
  const resolved = resolveWorkflow(paths, projectDir, nameOrPath);
  const problems: string[] = [];
  const notes: string[] = [];
  const dirs = openWorkflowDir(workflowDirs(projectDir, paths));
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
  const visit = (name: string, script: string, depth: number) => {
    if (seen.has(name)) return;
    seen.add(name);
    const where = name === resolved.name ? "" : ` (in ${name})`;
    const within = name === resolved.name ? "" : `in ${name}: `;
    if (depth > 5) {
      problems.push(`workflows nest more than 5 levels deep${where}`);
      return;
    }
    for (const child of literals(script, /\bworkflow\(\s*(['"])([A-Za-z0-9_.-]+)\1/g)) {
      const text = dirs.resolve(child);
      if (text === undefined) {
        problems.push(`no saved workflow "${child}"${where}`);
        continue;
      }
      try {
        parseWorkflowScript(text);
      } catch (error) {
        problems.push(`workflow "${child}" does not parse: ${(error as Error).message}`);
        continue;
      }
      visit(child, text, depth + 1);
    }
    for (const model of literals(script, /\bmodel\s*:\s*(['"])([^'"]+)\1/g)) {
      const removed = removedHarness(model);
      if (removed) problems.push(`${within}${removed}`);
    }
    // Each step's options: the agent it names, the model or harness, and its MCP servers.
    const steps = new Map<number, string>();
    for (const match of script.matchAll(/\b(agentType|mcp)\s*:/g)) {
      const step = enclosingObject(script, match.index);
      if (step) steps.set(step.start, step.text);
    }
    for (const text of steps.values()) {
      const agentType = literal(text, "agentType");
      const model = literal(text, "model");
      const servers = stringList(text, "mcp");
      if (agentType) {
        const planned = planStep(agents, agentType, { ...(model ? { model } : {}), ...(servers.length ? { mcp: servers } : {}) });
        if ("problem" in planned) {
          problems.push(`${within}${planned.problem}`);
          continue;
        }
        const { plan } = planned;
        if (!model && /\bmodel\s*:/.test(text) && plan.agent.from !== "rulesync") {
          const from = harnessName(plan.agent.from);
          notes.push(`${within}a step with agent "${agentType}" picks its harness while running. The agent comes from ${plan.agent.file}, so the step stops on any harness but ${from}.`);
        }
        checkServers(plan.mcp ?? [], plan.harness, within);
      } else if (!/\bagentType\s*:/.test(text)) {
        checkServers(servers, routeHarness(model, settings.env) ?? settings.defaultHarness, within);
      }
    }
    for (const file of literals(script, /\brun\(\s*(['"])([^'"]+)\1/g)) {
      const full = isAbsolute(file) ? file : join(projectDir, file);
      if (!existsSync(full)) notes.push(`script ${file} is not in ${projectDir}${where}. It must exist where the run works.`);
    }
    if (/\bchoose\([^)]*\bany\s*:\s*true/.test(script)) notes.push(`an agent may pick any saved workflow${where}`);
  };
  visit(resolved.name, resolved.script, 1);

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
