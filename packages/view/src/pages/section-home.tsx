import { Link, useRouterState } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import type { Question, RunRow } from "../api/contract.ts";
import { useQuestions, useRuns } from "../api/queries.ts";
import { formatAgo, formatCost, formatTokens, plural } from "../format.ts";
import { useHiddenRuns } from "../lists/removals.ts";
import { groupRuns, needsPerson } from "../lists/run-groups.ts";
import { sectionOf } from "../sections.ts";
import { useSidebarContext } from "../shell/use-sidebar.ts";
import { openStart } from "../start/start-store.ts";
import { Button } from "../ui/button.tsx";
import { EmptyState } from "../ui/empty-state.tsx";
import { RelativeTime } from "../ui/relative-time.tsx";
import { STATUS_LABEL, StatusIcon } from "../ui/status-icon.tsx";
import { AgentsHome, McpHome, SkillsHome, WorkflowsHome } from "./catalog-home.tsx";
import { HomeTable, notReady, Part, type Column } from "./home-parts.tsx";
import { Page } from "./page.tsx";
import { workflowWeek, type WorkflowWeek } from "./runs-week.ts";

// A section with nothing picked in its list. Runs shows what waits on the person and what each
// workflow did this week, plus the latest runs when the list column is not beside the page. The
// other sections say what they hold, count it, and list what needs a look.

const LATEST = 8;

/** "Breakpoint: Approve the release notes" from a prompt of many lines. */
const firstLine = (text: string) => text.split("\n").find((line) => line.trim())?.replace(/^#+\s*/, "").trim() ?? text;

const ASKS: Record<Question["kind"], string> = { confirm: "A yes or no", select: "A pick", input: "A question" };

function QuestionRow({ question, run }: { question: Question; run?: RunRow }) {
  const kind = question.breakpoint ? "A breakpoint" : ASKS[question.kind];
  return (
    <li className="flex gap-2.5 border-b border-line py-2.5">
      <span className="flex h-5 flex-none items-center">
        <StatusIcon status="needs" label={false} />
      </span>
      <div className="min-w-0 flex-1">
        {/* The time sits at the right of the first line, as in the run rows below, which leaves
            its tooltip button room around it. */}
        <div className="flex items-baseline gap-3">
          <Link to="/runs/$runId" params={{ runId: question.runId }} className="min-w-0 flex-1 font-medium text-fg no-underline [overflow-wrap:anywhere] hover:underline">
            {firstLine(question.prompt)}
          </Link>
          <span className="flex-none text-xs text-muted">
            <span className="sr-only">Asked </span>
            <RelativeTime at={question.askedAt} />
          </span>
        </div>
        <p className="mt-0.5 text-xs text-muted">
          {kind} in {run?.title ?? question.runId}
          {run && run.workflow !== run.title ? ` (${run.workflow})` : ""}
          {question.step ? `, step ${question.step}` : ""}.
        </p>
      </div>
    </li>
  );
}

function RunRowLink({ run, withProject }: { run: RunRow; withProject: boolean }) {
  const meta = [run.workflow === run.title ? "" : run.workflow, withProject ? run.project.name : ""].filter(Boolean).join(", ");
  return (
    <li className="border-b border-line">
      <Link to="/runs/$runId" params={{ runId: run.id }} className="flex h-9 items-center gap-2 px-1 text-fg no-underline hover:bg-hover max-[699px]:h-10">
        <StatusIcon status={needsPerson(run) ? "needs" : run.status} label={false} />
        <span className="fade-end min-w-0 flex-1">
          {run.title}
          {meta && <span className="ml-1 text-muted"> {meta}</span>}
        </span>
        {/* The icon says the status, so only words that add to it show, such as "Paused at a usage limit". */}
        {run.statusText !== STATUS_LABEL[needsPerson(run) ? "needs" : run.status] && <span className="flex-none text-xs text-muted max-[699px]:hidden">{run.statusText}</span>}
        <span className="w-16 flex-none text-right text-xs text-muted tabular-nums">{formatAgo(Date.parse(run.startedAt))}</span>
      </Link>
    </li>
  );
}

/** "3 done, 1 failed", for a screen reader, from a workflow's recent outcomes. */
function outcomes(recent: WorkflowWeek["recent"]): string {
  const counts = new Map<string, number>();
  for (const { status } of recent) counts.set(STATUS_LABEL[status].toLowerCase(), (counts.get(STATUS_LABEL[status].toLowerCase()) ?? 0) + 1);
  return [...counts].map(([label, n]) => `${n} ${label}`).join(", ");
}

const WEEK_COLUMNS: Column<WorkflowWeek>[] = [
  {
    head: "Workflow",
    fill: true,
    cell: (row) => (
      <Link to="/workflows/$name" params={{ name: row.workflow }} className="block py-2 font-medium text-fg no-underline hover:underline">
        {row.workflow}
      </Link>
    ),
  },
  {
    head: "Last runs",
    hideBelow: 600,
    cell: (row) => (
      <span role="img" aria-label={`Last ${row.recent.length}: ${outcomes(row.recent)}`} className="flex items-center gap-1">
        {row.recent.map((run) => (
          <StatusIcon key={run.id} status={run.status} label={false} size={12} />
        ))}
      </span>
    ),
  },
  { head: "Runs", num: true, cell: (row) => row.runs },
  { head: "Tokens", num: true, muted: true, hideBelow: 700, cell: (row) => (row.tokens > 0 ? formatTokens(row.tokens) : "") },
  { head: "Cost", num: true, muted: true, cell: (row) => (row.cost === undefined ? "" : formatCost(row.cost)) },
  { head: "Last", num: true, muted: true, hideBelow: 450, cell: (row) => <span className="text-xs">{formatAgo(Date.parse(row.lastAt))}</span> },
];

function RunsHome() {
  const runs = useRuns();
  const questions = useQuestions();
  const hidden = useHiddenRuns();
  const sidebar = useSidebarContext();
  const waiting = notReady(runs, "Loading runs");
  if (waiting || !runs.data) return <Page title="Runs">{waiting}</Page>;

  const all = runs.data.filter((run) => !hidden.has(run.id));
  if (!all.length) {
    return (
      <Page title="Runs">
        <EmptyState
          title="No runs yet"
          command="sous run <workflow>"
          action={
            <Button variant="primary" icon={Plus} onClick={() => openStart()}>
              Start a workflow
            </Button>
          }
        >
          A run is one go of a workflow. Start one here, or from a terminal, and it shows here with its steps and what it waits on.
        </EmptyState>
      </Page>
    );
  }

  const byId = new Map(all.map((run) => [run.id, run]));
  const asked = (questions.data ?? []).filter((q) => byId.has(q.runId)).sort((a, b) => Date.parse(a.askedAt) - Date.parse(b.askedAt));
  const counts = groupRuns(all, "status").map((g) => (g.key === "needs" ? `${g.items.length} ${g.items.length === 1 ? "needs" : "need"} you` : `${g.items.length} ${g.label.toLowerCase()}`));
  const latest = [...all].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, LATEST);
  const mixed = new Set(all.map((run) => run.project.dir)).size > 1;
  const week = workflowWeek(all, Date.now());
  // The list column beside the page already lists the runs, so the home leaves them out then.
  const beside = sidebar.open && !sidebar.overlay;

  return (
    <Page title="Runs">
      <p className="mt-1 text-md text-muted">
        {plural(all.length, "run")}: {counts.join(", ")}.
      </p>
      {asked.length > 0 ? (
        <Part title="Waiting on you" count={asked.length}>
          <ul className="border-t border-line">
            {asked.map((q) => (
              <QuestionRow key={q.id} question={q} run={byId.get(q.runId)} />
            ))}
          </ul>
        </Part>
      ) : (
        questions.isSuccess && <p className="mt-6 text-muted">No run waits on you now.</p>
      )}
      {week.length > 0 && (
        <Part title="This week" count={week.length}>
          <HomeTable rows={week} columns={WEEK_COLUMNS} rowKey={(row) => row.workflow} />
        </Part>
      )}
      {!beside && (
        <Part title="Latest runs">
          <ul className="border-t border-line">
            {latest.map((run) => (
              <RunRowLink key={run.id} run={run} withProject={mixed} />
            ))}
          </ul>
          {all.length > LATEST && !sidebar.open && (
            <Button variant="quiet" size="sm" className="mt-2" onClick={sidebar.show}>
              Show all {all.length} runs
            </Button>
          )}
        </Part>
      )}
    </Page>
  );
}

/** A section with nothing picked in its list. */
export function SectionHome() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const section = sectionOf(pathname);
  switch (section?.id) {
    case "runs":
      return <RunsHome />;
    case "workflows":
      return <WorkflowsHome section={section} />;
    case "agents":
      return <AgentsHome section={section} />;
    case "skills":
      return <SkillsHome section={section} />;
    case "mcp":
      return <McpHome section={section} />;
    default:
      return <Page title="sous" />;
  }
}
