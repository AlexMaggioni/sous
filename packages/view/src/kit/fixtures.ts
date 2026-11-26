// The mock's workflows and runs (docs/features/view/mock/data.js and runs.js) in the contract's
// types, for the kit and the tests to show each state of the graph. Steps carry the labels and
// names the engine gives them, so planOf lays them over the text as it does a real run's.
import type { Flow, FlowNode, FlowStep, NestedRun, Question, Status, Step } from "../api/contract.ts";
import { planOf, type Plan, type PlanRun } from "../plan/plan.ts";

let seq = 0;
const at = () => ({ id: `n${++seq}`, line: seq });
const step = (kind: FlowStep["kind"], label: string, more: Partial<FlowStep> = {}): FlowStep => ({ t: "step", ...at(), kind, label, ...more });
const agent = (label: string, agentType = label, more: Partial<FlowStep> = {}) => step("agent", label, { agent: agentType, ...more });
const sh = (label: string, more: Partial<FlowStep> = {}) => step("sh", label, more);
const end = (): FlowNode => ({ t: "end", ...at() });
const flow = (...nodes: FlowNode[]): Flow => ({ nodes, notes: [] });

const ticket = flow(
  agent("implementer"),
  { t: "loop", ...at(), loop: "gate", limit: "args.rounds", body: [{ t: "if", ...at(), cond: "feedback", then: [agent("address review", "implementer")] }, agent("reviewer")] },
  { t: "if", ...at(), cond: "!review.ok", then: [end()] },
  sh("tests"),
  sh("commit"),
);

const factory = flow(
  sh("fetch"),
  agent("triager"),
  step("ask", "Build these?"),
  { t: "if", ...at(), cond: 'pick === "Build none"', then: [end()] },
  { t: "pipeline", ...at(), over: "chosen", stages: [[step("workflow", "ticket {letter}", { workflow: "ticket", dynamic: true })]] },
);

const reviewPr = flow(
  sh("diff"),
  { t: "parallel", ...at(), branches: [[agent("reviewer")], [agent("security", "security-reviewer")]] },
  step("breakpoint", "Post this review?", { body: [agent("comment", "writer")] }),
  sh("post"),
);

const docsSync = flow(sh("changes"), agent("update docs", "docs-writer"), agent("review", "reviewer"));

const releaseNotes = flow(
  sh("log"),
  step("breakpoint", "Notes look right?", { body: [agent("draft", "writer")] }),
  step("js", "changelog"),
  step("workflow", "docs", { workflow: "docs-sync" }),
);

const fixFlaky = flow(
  step("run", "reproduce"),
  agent("investigate", "investigator"),
  { t: "loop", ...at(), loop: "retry", limit: "2", body: [agent("fix", "implementer"), sh("check")] },
  sh("verify", { retries: 2 }),
);

const depsUpdate = flow(
  sh("outdated"),
  {
    t: "pipeline",
    ...at(),
    over: "packages",
    stages: [[agent("upgrade {name}", "codex-fixer", { dynamic: true, model: "codex" })], [sh("test {name}", { dynamic: true })]],
  },
  sh("tests"),
);

const triageBugs = flow(
  agent("triage", "triager"),
  step("checkpoint", "Plan the urgent ones now?"),
  { t: "if", ...at(), cond: "!go", then: [end()] },
  agent("plan", "planner"),
  step("choose", "pick what to run"),
);

const migrate = flow(sh("inventory"), agent("migrate", "implementer"), sh("backfill"), sh("tests"));

// ── Runs ──

const T0 = Date.now() - 40 * 60_000;
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();

/** A step as the engine records it: label, then kind, status, the minute it started and its seconds. */
type S = [label: string, kind: Step["kind"], status: Status, start: number, secs?: number, tries?: number];

function steps(scope: string, list: S[], prefix = ""): Step[] {
  const calls = new Map<string, number>();
  return list.map(([label, kind, status, start, secs, tries], i) => {
    const call = (calls.get(label) ?? 0) + 1;
    calls.set(label, call);
    const ended = secs !== undefined && status !== "running" && status !== "needs";
    return {
      key: `${scope}:${i + 1}`,
      label,
      name: prefix ? `${prefix}: ${label}` : label,
      scope,
      call,
      kind,
      status,
      startedAt: iso(start),
      ...(ended ? { endedAt: iso(start + secs / 60), durationMs: secs * 1000 } : {}),
      ...(tries ? { tries } : {}),
    };
  });
}

const question = (runId: string, prompt: string, breakpoint = false): Question => ({
  id: `q-${runId}`,
  runId,
  scope: runId,
  workflow: "triage-bugs",
  prompt,
  kind: "confirm",
  choices: ["Yes", "No"],
  breakpoint,
  answeredBy: "people",
  askedAt: iso(30),
});

const ticketSteps = (run: string) => ["A", "B", "C"].flatMap((t, i) =>
  steps(`${run}.${i + 1}`, [
    ["implementer", "agent", "done", 4 + i, 240],
    ["reviewer", "agent", "done", 9 + i, 95],
    ["tests", "exec", "done", 11 + i, 48],
    ["commit", "exec", "done", 12 + i, 2],
  ], `ticket ${t}`),
);
const factoryNested: NestedRun[] = ["A", "B", "C"].map((t, i) => ({ id: `r-6w1n5c.${i + 1}`, parent: "r-6w1n5c", workflow: "ticket", label: `ticket ${t}` }));

/** What a state draws: a workflow's text, and for a run the parts of it the plan reads. */
export type GraphInput = Partial<PlanRun> & { flow?: Flow; flows?: Record<string, Flow> };

export type GraphState = { title: string; note: string; props: GraphInput };

/** The plan of a state at `now`, as a page makes it. */
export const planOfState = ({ flow, flows, steps, ...run }: GraphInput, now?: number): Plan | null => planOf(flow, flows, steps ? { ...run, steps } : undefined, now);

/** Each state the kit shows, in the order of the brief. */
export const GRAPH_STATES: GraphState[] = [
  {
    title: "Saved workflow",
    note: "factory, with kind icons. The early return ends at its own mark, and the pipeline is one stacked node.",
    props: { flow: factory, flows: { ticket } },
  },
  {
    title: "Saved workflow with a nested workflow",
    note: "release-notes. The breakpoint runs its step first, and the docs box opens to the graph of docs-sync.",
    props: { flow: releaseNotes, flows: { "docs-sync": docsSync } },
  },
  {
    title: "Run in progress",
    note: "The running step turns and its time counts up. What has not run yet is gray.",
    props: { flow: migrate, status: "running", steps: steps("r-0z5q9k", [["inventory", "exec", "done", 0, 40], ["migrate", "agent", "running", 1]]) },
  },
  {
    title: "Failed",
    note: "fix-flaky. The retry ran both of its rounds, and verify failed after three tries.",
    props: {
      flow: fixFlaky,
      status: "failed",
      steps: steps("r-8d2v7f", [
        ["reproduce", "exec", "done", 0, 70],
        ["investigate", "agent", "done", 2, 300],
        ["fix", "agent", "done", 8, 260],
        ["check", "exec", "done", 13, 55],
        ["fix", "agent", "done", 14, 200],
        ["check", "exec", "done", 18, 52],
        ["verify", "exec", "failed", 19, 210, 3],
      ]),
    },
  },
  {
    title: "Needs you",
    note: "triage-bugs waits at its checkpoint. Its node has the copper border.",
    props: {
      flow: triageBugs,
      status: "needs",
      steps: steps("r-9h3t6e", [["triage", "agent", "done", 0, 180]]),
      questions: [question("r-9h3t6e", "Plan the urgent ones now?")],
    },
  },
  {
    title: "Loop in round 2 of 3",
    note: "ticket. The reviewer asked for changes once, so the box shows the second round.",
    props: {
      flow: ticket,
      status: "running",
      args: { ticket: "BILL-142", rounds: 3 },
      steps: steps("r-1k6s3g", [
        ["implementer", "agent", "done", 0, 420],
        ["reviewer", "agent", "done", 8, 120],
        ["address review", "agent", "running", 11],
      ]),
    },
  },
  {
    title: "Parallel branches",
    note: "review-pr. Both reviewers run at once, then join before the breakpoint.",
    props: {
      flow: reviewPr,
      status: "running",
      steps: steps("r-3m8x2j", [
        ["diff", "exec", "done", 0, 3],
        ["reviewer", "agent", "running", 1],
        ["security", "agent", "done", 1, 150],
      ]),
    },
  },
  {
    title: "Pipeline of 4",
    note: "deps-update. One item waits on you, so the pipeline opens to its four items.",
    props: {
      flow: depsUpdate,
      status: "needs",
      steps: steps("r-7e3d1n", [
        ["outdated", "exec", "done", 0, 9],
        ["upgrade react", "agent", "done", 1, 200],
        ["upgrade vite", "agent", "done", 1, 140],
        ["upgrade zod", "agent", "running", 1],
        ["upgrade typescript", "agent", "needs", 2],
        ["test vite", "exec", "running", 4],
        ["test react", "exec", "done", 5, 61],
      ]),
    },
  },
  {
    title: "Nested workflow",
    note: "release-notes started docs-sync, which shows in its own box with its own steps.",
    props: {
      flow: releaseNotes,
      flows: { "docs-sync": docsSync },
      status: "running",
      nested: [{ id: "r-4p7k8b.1", parent: "r-4p7k8b", workflow: "docs-sync", label: "docs" }],
      steps: [
        ...steps("r-4p7k8b", [
          ["log", "exec", "done", 0, 2],
          ["draft", "agent", "done", 1, 330],
          ["changelog", "exec", "done", 9, 1],
        ]),
        ...steps("r-4p7k8b.1", [["changes", "exec", "done", 10, 4], ["update docs", "agent", "running", 10]], "docs"),
      ],
    },
  },
  {
    title: "Early end",
    note: "ticket. The reviewer never approved in three rounds, so the run ended before the tests.",
    props: {
      flow: ticket,
      status: "done",
      args: { rounds: 3 },
      steps: steps("r-5t9b4h", [
        ["implementer", "agent", "done", 0, 380],
        ["reviewer", "agent", "done", 7, 110],
        ["address review", "agent", "done", 9, 200],
        ["reviewer", "agent", "done", 13, 100],
        ["address review", "agent", "done", 15, 180],
        ["reviewer", "agent", "done", 18, 90],
      ]),
    },
  },
  {
    title: "Folded box",
    note: "factory built three tickets. A finished pipeline folds to one stacked node, and a click opens it.",
    props: {
      flow: factory,
      flows: { ticket },
      status: "done",
      args: { rounds: 3 },
      nested: factoryNested,
      steps: [...steps("r-6w1n5c", [["fetch", "exec", "done", 0, 6], ["triager", "agent", "done", 1, 150]]), ...ticketSteps("r-6w1n5c")],
    },
  },
  {
    title: "Steps as they ran",
    note: "sous could not read this run's text, so the graph shows its steps in order. ticket A still gets its own box.",
    props: {
      flows: { ticket },
      status: "done",
      steps: [...steps("r-2c8f1d", [["fetch", "exec", "done", 0, 6], ["triager", "agent", "done", 1, 150]]), ...ticketSteps("r-2c8f1d").slice(0, 4)],
    },
  },
];
