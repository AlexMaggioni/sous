// `orc check`: what can be known about a workflow without running it. The script parses, the
// inputs given fit what it declares, and each workflow, agent, MCP server and script file it
// names exists. Names built at run time can't be checked, so the check reads literals only.

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { agentDirsFromOption, loadAgentRegistry, openWorkflowDir, parseWorkflowScript } from "@automatalabs/workflow-engine";
import { agentsDirOption, loadMcpServers, loadSecrets, workflowDirs, type HomePaths } from "./home.js";
import { checkInputs } from "./inputs.js";
import { resolveWorkflow } from "./launch.js";

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

export function checkWorkflow(paths: HomePaths, projectDir: string, nameOrPath: string, given?: Record<string, unknown>): CheckResult {
  const resolved = resolveWorkflow(paths, projectDir, nameOrPath);
  const problems: string[] = [];
  const notes: string[] = [];
  const dirs = openWorkflowDir(workflowDirs(projectDir, paths));
  const registry = loadAgentRegistry(projectDir, agentDirsFromOption(agentsDirOption(projectDir, paths)));
  let servers: Record<string, unknown> = {};
  try {
    servers = loadMcpServers(projectDir, paths, { ...process.env, ...loadSecrets(paths) });
  } catch (error) {
    problems.push((error as Error).message);
  }

  problems.push(...(resolved.extras.metaProblems ?? []));
  if (given) {
    problems.push(...checkInputs(resolved.extras, given).problems);
  }

  const seen = new Set<string>();
  const visit = (name: string, script: string, depth: number) => {
    if (seen.has(name)) return;
    seen.add(name);
    const where = name === resolved.name ? "" : ` (in ${name})`;
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
    for (const agentType of literals(script, /\bagentType\s*:\s*(['"])([^'"]+)\1/g)) {
      if (!registry.has(agentType)) {
        problems.push(`no agent "${agentType}"${where}. Agents live in .orchestrator/agents/ or ~/.orchestrator/agents/ as <name>.md.`);
      }
    }
    for (const server of stringList(script, "mcp")) {
      if (!(server in servers)) problems.push(`MCP server "${server}" is not in mcp.json${where}`);
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
  return {
    workflow: resolved.name,
    file: resolved.file,
    ...(extras.description ? { description: extras.description } : {}),
    inputs: extras.inputs,
    problems,
    notes,
  };
}
