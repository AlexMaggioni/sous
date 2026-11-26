// What the page reads besides runs and workflows: the overview every page needs, the settings, and
// the agents, skills and MCP servers seen from a project. Each maps the engine's reads to the
// contract's shape.

import { daemonPid, isHarness, knownProjects, listAccounts, listAgents, listMcpServers, listSkills, loadConfig, runQuestions, type HomePaths } from "@sous-run/engine";
import type { AgentRow, Harness, Overview, Settings } from "@sous-run/view";
import { projectOf } from "./runs.js";

/** The home, the project sous serve started in and the others sous knows, the service, how many
 *  runs wait on the person, and the version that serves the page. */
export function overview(paths: HomePaths, project: string, version: string): Overview {
  const others = knownProjects(paths).filter((dir) => dir !== project);
  return {
    home: paths.home,
    project: projectOf(project),
    projects: [project, ...others].map(projectOf),
    service: { running: daemonPid(paths) !== undefined },
    needsYou: new Set(runQuestions(paths).map((question) => question.runId)).size,
    version,
  };
}

/** config.json with its defaults, the service, and each program's accounts. Tokens stay out. */
export function settings(paths: HomePaths): Settings {
  const pid = daemonPid(paths);
  return {
    home: paths.home,
    config: { ...loadConfig(paths) },
    service: { running: pid !== undefined, ...(pid === undefined ? {} : { pid }) },
    accounts: listAccounts(paths).map(({ program, name, current }) => ({ program, name, current })),
  };
}

/** The agents a step of the project can name, and the names it can't use as they are, with why. */
export function agentRows(paths: HomePaths, projectDir: string, env: NodeJS.ProcessEnv): AgentRow[] {
  const { agents, problems } = listAgents(paths, projectDir, env);
  const configured = loadConfig(paths).defaultHarness;
  const harness: Harness = configured && isHarness(configured) ? configured : "claude";
  const rows: AgentRow[] = agents.map((agent) => ({ ...agent }));
  for (const problem of problems) rows.push({ name: problem.name, harness, file: problem.files[0] ?? "", problem: problem.message });
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** What the live feed compares to see the catalog change: the rows of the agents, skills and MCP
 *  servers, and the files of the agents and skills, which the server stamps. */
export function catalogPrint(paths: HomePaths, projectDir: string, env: NodeJS.ProcessEnv): { text: string; files: string[] } {
  const read = <T>(rows: () => T[]): T[] | string => {
    try {
      return rows();
    } catch (error) {
      return String(error);
    }
  };
  const agents = read(() => agentRows(paths, projectDir, env));
  const skills = read(() => listSkills(paths, projectDir, env));
  const mcp = read(() => listMcpServers(paths, projectDir, env));
  const files = [...(Array.isArray(agents) ? agents : []), ...(Array.isArray(skills) ? skills : [])].map((row) => row.file).filter(Boolean);
  return { text: JSON.stringify([agents, skills, mcp]), files };
}
