import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { callSous, deleteJson, getJson, postJson, withQuery } from "./client.ts";
import type {
  AgentPage,
  AgentRow,
  LiveEvent,
  McpPage,
  McpRow,
  Overview,
  Question,
  Removed,
  RunPage,
  RunRow,
  Settings,
  SkillPage,
  SkillRow,
  StepDetail,
  WorkflowDiff,
  WorkflowPage,
  WorkflowRow,
} from "./contract.ts";

// The reads and writes of the page, one hook each. Data stays fresh through /api/live, which
// says what changed, so no query polls.

/** The query keys. The first word of each is what /api/live names when it changes. */
const keys = {
  overview: ["overview"] as const,
  runs: ["runs"] as const,
  run: (id: string) => ["run", id] as const,
  step: (id: string, name: string, call?: number) => ["step", id, name, call ?? 0] as const,
  questions: ["questions"] as const,
  workflows: (project?: string) => ["workflows", project ?? ""] as const,
  workflow: (name: string, project?: string) => ["workflow", project ?? "", name] as const,
  diff: (name: string, project?: string) => ["diff", project ?? "", name] as const,
  agents: (project?: string) => ["agents", project ?? ""] as const,
  agent: (name: string, project?: string) => ["agent", project ?? "", name] as const,
  skills: (project?: string) => ["skills", project ?? ""] as const,
  skill: (name: string, project?: string) => ["skill", project ?? "", name] as const,
  mcps: (project?: string) => ["mcps", project ?? ""] as const,
  mcp: (name: string, project?: string) => ["mcp", project ?? "", name] as const,
  settings: ["settings"] as const,
};

const named = (base: string, name: string) => `${base}/${encodeURIComponent(name)}`;

export const useOverview = () => useQuery({ queryKey: keys.overview, queryFn: () => getJson<Overview>("overview") });
export const useRuns = () => useQuery({ queryKey: keys.runs, queryFn: () => getJson<RunRow[]>("runs") });
export const useRun = (id: string) => useQuery({ queryKey: keys.run(id), queryFn: () => getJson<RunPage>(named("runs", id)) });
export const useQuestions = () => useQuery({ queryKey: keys.questions, queryFn: () => getJson<Question[]>("questions") });

/** One step call, whole. Only asked for while its panel is open. */
export const useStep = (runId: string, name: string, call?: number, enabled = true) =>
  useQuery({ queryKey: keys.step(runId, name, call), queryFn: () => getJson<StepDetail>(withQuery(`${named("runs", runId)}/step`, { name, call })), enabled });

export const useWorkflows = (project?: string) => useQuery({ queryKey: keys.workflows(project), queryFn: () => getJson<WorkflowRow[]>(withQuery("workflows", { project })) });
export const useWorkflow = (name: string, project?: string) =>
  useQuery({ queryKey: keys.workflow(name, project), queryFn: () => getJson<WorkflowPage>(withQuery(named("workflows", name), { project })) });
export const useWorkflowDiff = (name: string, project?: string, enabled = true) =>
  useQuery({ queryKey: keys.diff(name, project), queryFn: () => getJson<WorkflowDiff>(withQuery(`${named("workflows", name)}/diff`, { project })), enabled });

export const useAgents = (project?: string) => useQuery({ queryKey: keys.agents(project), queryFn: () => getJson<AgentRow[]>(withQuery("agents", { project })) });
export const useAgent = (name: string, project?: string, enabled = true) =>
  useQuery({ queryKey: keys.agent(name, project), queryFn: () => getJson<AgentPage>(withQuery(named("agents", name), { project })), enabled });
export const useSkills = (project?: string) => useQuery({ queryKey: keys.skills(project), queryFn: () => getJson<SkillRow[]>(withQuery("skills", { project })) });
export const useSkill = (name: string, project?: string) => useQuery({ queryKey: keys.skill(name, project), queryFn: () => getJson<SkillPage>(withQuery(named("skills", name), { project })) });
export const useMcps = (project?: string) => useQuery({ queryKey: keys.mcps(project), queryFn: () => getJson<McpRow[]>(withQuery("mcp", { project })) });
export const useMcp = (name: string, project?: string) => useQuery({ queryKey: keys.mcp(name, project), queryFn: () => getJson<McpPage>(withQuery(named("mcp", name), { project })) });
export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: () => getJson<Settings>("settings") });

/** Read again what a change in the home touches. */
export function applyLive(client: QueryClient, event: LiveEvent): void {
  if (event.type !== "changed") return;
  const again = (word: string) => void client.invalidateQueries({ queryKey: [word] });
  if (event.runs.length || event.questions) {
    again("overview");
    again("runs");
  }
  for (const id of event.runs) {
    void client.invalidateQueries({ queryKey: ["run", id] });
    void client.invalidateQueries({ queryKey: ["step", id] });
  }
  if (event.questions) again("questions");
  if (event.workflows) for (const word of ["workflows", "workflow", "diff"]) again(word);
  if (event.catalog) for (const word of ["agents", "agent", "skills", "skill", "mcps", "mcp"]) again(word);
}

/** Read everything again, as after the connection came back. */
export const refreshAll = (client: QueryClient) => void client.invalidateQueries();

/** Run one sous command as the person, then read again what it may have changed. */
export function useCall() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (argv: string[]) => callSous(argv),
    onSettled: () => {
      for (const word of ["overview", "runs", "run", "step", "questions", "workflow", "workflows", "diff"]) void client.invalidateQueries({ queryKey: [word] });
    },
  });
}

/** Remove a run that ended, from the list and the home. */
export function useRemoveRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteJson<Removed>(named("runs", id)),
    onSettled: () => {
      for (const word of ["overview", "runs", "run"]) void client.invalidateQueries({ queryKey: [word] });
    },
  });
}

/** Move a saved workflow file to the home's trash. */
export function useTrashWorkflow(project?: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => postJson<Removed>(withQuery(`${named("workflows", name)}/trash`, { project })),
    onSettled: () => {
      for (const word of ["workflows", "workflow", "diff"]) void client.invalidateQueries({ queryKey: [word] });
    },
  });
}
