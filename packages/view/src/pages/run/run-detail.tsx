// One run: its header, the notes on why it stopped, what needs the person, and the Graph and Steps
// views of its plan, with the selected step's panel beside them. The view and the selected step
// live in the URL, so a link opens the same page.
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { SousError } from "../../api/client.ts";
import type { Question, RunPage } from "../../api/contract.ts";
import { useRun } from "../../api/queries.ts";
import { useProjectSearch } from "../../api/seen-from.ts";
import { useSend } from "../../api/send.ts";
import { formatCost, formatDuration, formatTokens, plural } from "../../format.ts";
import { findPart } from "../../graph/tree.ts";
import { planOf } from "../../plan/plan.ts";
import { PlanView } from "../../plan/plan-view.tsx";
import type { ProjectSearch, RunSearch } from "../../router.tsx";
import { isEnded, isLive } from "../../status.ts";
import { Button } from "../../ui/button.tsx";
import { OriginChip, StatusChip } from "../../ui/chip.tsx";
import { CopyButton } from "../../ui/copy.tsx";
import { EmptyState } from "../../ui/empty-state.tsx";
import { Facts, type Fact } from "../../ui/facts.tsx";
import { Refusal } from "../../ui/refusal.tsx";
import { RelativeTime } from "../../ui/relative-time.tsx";
import { Segmented } from "../../ui/segmented.tsx";
import { useShift } from "../../ui/motion.ts";
import { LoadingRows, Skel } from "../../ui/skeleton.tsx";
import { Tip } from "../../ui/tooltip.tsx";
import { Page } from "../page.tsx";
import { NeedsYou } from "./needs-you.tsx";
import { Notices } from "./notices.tsx";
import { RunActions } from "./run-actions.tsx";
import { RoomCall } from "./room-call.tsx";
import { StepCall } from "./step-call.tsx";
import { useNow } from "./use-now.ts";

const VIEWS = [
  { value: "graph", label: "Graph" },
  { value: "steps", label: "Steps" },
] as const;

/** The breadcrumb's parts. Page puts them in its own nav. */
function Crumbs({ id }: { id: string }) {
  return (
    <>
      <Link to="/runs" className="rounded-sm hover:text-fg">
        Runs
      </Link>
      <span aria-hidden="true">/</span>
      <span aria-current="page" className="min-w-0 truncate font-mono">
        {id}
      </span>
    </>
  );
}

/** How long the run has run. A live run adds the time since the page read it, so it ticks. */
function runDuration(run: RunPage, now: number, readAt: number): number | undefined {
  if (isLive(run.status)) return (run.durationMs ?? readAt - Date.parse(run.startedAt)) + Math.max(0, now - readAt);
  return run.durationMs ?? (run.endedAt ? Date.parse(run.endedAt) - Date.parse(run.startedAt) : undefined);
}

/** Where the run works: its branch in a worktree, the project folder, or a scratch folder. */
function placeFact(run: RunPage): Fact {
  if (run.place === "worktree" && run.branch) return { label: "Branch", value: <span className="font-mono text-xs">{run.branch}</span> };
  return { label: "Place", value: run.place === "folder" ? "The project folder" : run.place === "worktree" ? "A worktree" : "A scratch folder" };
}

/** `search` opens the workflow as seen from the run's project. */
function runFacts(run: RunPage, now: number, readAt: number, search: ProjectSearch): Fact[] {
  const duration = runDuration(run, now, readAt);
  const facts: (Fact | false)[] = [
    // The title is the workflow's name unless the run was given its own.
    run.title !== run.workflow && {
      label: "Workflow",
      value: (
        <Link to="/workflows/$name" params={{ name: run.workflow }} search={search} className="rounded-sm underline decoration-1 underline-offset-2">
          {run.workflow}
        </Link>
      ),
    },
    {
      label: "Project",
      value: (
        <Tip text={run.project.dir}>
          <span tabIndex={0} className="rounded-sm">
            {run.project.name}
          </span>
        </Tip>
      ),
    },
    placeFact(run),
    { label: "Started by", value: <OriginChip origin={run.origin} /> },
    { label: "Started", value: <RelativeTime at={run.startedAt} /> },
    !!run.endedAt && { label: "Finished", value: <RelativeTime at={run.endedAt} /> },
    duration !== undefined && { label: "Duration", value: formatDuration(duration) },
    // A run of code steps only, or one whose agents have not reported yet, has no tokens to show.
    run.tokens > 0 && { label: "Tokens", value: formatTokens(run.tokens) },
    run.cost !== undefined && { label: "Cost", value: formatCost(run.cost) },
  ];
  return facts.filter((f): f is Fact => f !== false);
}

/** The page while the run loads: the header's shape in gray, then rows. */
function Loading({ id }: { id: string }) {
  return (
    <Page
      crumbs={<Crumbs id={id} />}
      title={
        <>
          <span className="sr-only">Loading {id}</span>
          <Skel className="inline-block h-6 w-48 align-middle" />
        </>
      }
    >
      <div className="mt-2 h-6">
        <Skel className="inline-block h-4 w-64" />
      </div>
      <div className="mt-4 flex flex-wrap gap-x-10 gap-y-3">
        {["w-20", "w-16", "w-24", "w-18", "w-14"].map((w) => (
          <Skel key={w} className={`inline-block h-9 ${w}`} />
        ))}
      </div>
      <div className="mt-10">
        <LoadingRows label="Loading the run" rows={5} />
      </div>
    </Page>
  );
}

/** The server has no such run: it was removed, or the id is wrong. */
const isMissing = (error: unknown) => error instanceof SousError && (error.status === 404 || error.code === "no_such_run");

function Failed({ id, error, retry }: { id: string; error: unknown; retry: () => void }) {
  const missing = isMissing(error);
  return (
    <Page crumbs={<Crumbs id={id} />} title={missing ? "Run not found" : "The run did not load"}>
      {missing ? (
        <EmptyState
          title={`No run ${id}`}
          action={
            <Link to="/runs" className="inline-flex h-8 items-center rounded-md bg-hover px-3 font-medium hover:bg-selected max-[699px]:h-10">
              Back to runs
            </Link>
          }
        >
          It was removed, or the link has a wrong id. sous list shows the runs.
        </EmptyState>
      ) : (
        <div className="mt-4">
          <Refusal
            error={error}
            action={
              <Button size="sm" onClick={retry}>
                Try again
              </Button>
            }
          />
        </div>
      )}
    </Page>
  );
}

function Loaded({ run, readAt, search }: { run: RunPage; readAt: number; search: RunSearch }) {
  const navigate = useNavigate({ from: "/runs/$runId" });
  const now = useNow(isLive(run.status));
  const { send, error, clear } = useSend();
  // Links to the workflow and its agents open them as seen from the run's project.
  const seenFromRun = useProjectSearch(run.project.dir);
  const view = search.view === "steps" ? "steps" : "graph";
  // The questions answered here that let the run go on, so their gate reads done as the answer lands.
  const [passed, setPassed] = useState<Question[]>([]);
  const pass = (question: Question) => setPassed((list) => [...list.filter((q) => q.runId === run.id), question]);
  const plan = useMemo(() => planOf(run.flow, run.flows, run, now, passed), [run, now, passed]);
  // The views slide down or up when a question or a notice above them opens or closes.
  const views = useRef<HTMLDivElement>(null);
  useShift(views, run.id);
  const selected = search.step && plan ? findPart(plan.graph, search.step) : undefined;
  // While the failed step is selected, its "Resume from here" is the page's one primary.
  const primaryHere = selected?.t === "leaf" && selected.status === "failed" && run.can.resume && run.questions.length === 0;
  const setView = (next: "graph" | "steps") => void navigate({ search: (s) => ({ step: s.step, view: next === "steps" ? "steps" : undefined }), replace: true });
  const setStep = (key: string | undefined) => void navigate({ search: (s) => ({ view: s.view, step: key }), replace: true });
  const done = run.steps.filter((s) => s.status === "done").length;
  // Steps that haven't started have no row yet, so "3 of 3 done" would read as finished while a
  // step still waits. Until the run ends, the counter says how many are done so far.
  const ended = isEnded(run.status);
  return (
    <Page crumbs={<Crumbs id={run.id} />} title={run.title} actions={<RunActions run={run} send={send} primaryHere={primaryHere} />}>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-0.5 font-mono text-xs text-muted">
          {run.id}
          <CopyButton text={run.id} label="Copy the run id" />
        </span>
        <StatusChip status={run.status} text={run.statusText} />
      </div>
      <div className="mt-4">
        <Facts layout="row" items={runFacts(run, now, readAt, seenFromRun)} />
      </div>
      {error !== null && (
        <div className="mt-4">
          <Refusal
            error={error}
            action={
              <Button size="sm" variant="quiet" onClick={clear}>
                Dismiss
              </Button>
            }
          />
        </div>
      )}
      <Notices run={run} onOpenStep={setStep} />
      <NeedsYou run={run} onOpenStep={setStep} onPassed={pass} />
      <div ref={views}>
        <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
          <Segmented label="View" value={view} onChange={setView} options={VIEWS} />
          {run.steps.length > 0 && (
            <span className="text-xs text-muted">
              {ended ? `${done} of ${plural(run.steps.length, "step")} done` : `${plural(done, "step")} done so far`}
            </span>
          )}
        </div>
        <div className="mt-3">
          <PlanView
            view={view}
            plan={plan}
            flow={run.flow}
            flows={run.flows}
            run={run}
            now={now}
            selected={search.step}
            onSelect={setStep}
            label={`Graph of ${run.id}`}
            project={run.project.dir}
            onLine={(line, flow) => void navigate({ to: "/workflows/$name", params: { name: flow ?? run.workflow }, search: { ...seenFromRun, view: "source", line } })}
            call={(leaf, about, node) => (
              <StepCall key={leaf.key} run={run} leaf={leaf} now={now} primary={primaryHere} onSelect={setStep} about={about} source={node?.t === "step" ? node.code : undefined} onPassed={pass} />
            )}
            room={(box, about) => <RoomCall key={box.key} run={run} box={box} onSelect={setStep} about={about} />}
            empty={<p className="mt-4 text-muted">{isLive(run.status) ? "No step has started yet. Steps show here as they start." : "This run ran no steps."}</p>}
          />
        </div>
      </div>
    </Page>
  );
}

/** One run, at #/runs/$runId, with ?view=steps for the Steps view and ?step= for the open step. */
export function RunDetail(): ReactNode {
  const { runId } = useParams({ from: "/runs/$runId" });
  const search = useSearch({ from: "/runs/$runId" });
  const run = useRun(runId);
  if (run.isPending) return <Loading id={runId} />;
  // A read that fails after one that worked keeps the run on the page, unless the run is gone.
  // Another run starts afresh, so no refusal or answer of the last one stays.
  if (run.data && !isMissing(run.error)) return <Loaded key={run.data.id} run={run.data} readAt={run.dataUpdatedAt} search={search} />;
  return <Failed id={runId} error={run.error} retry={() => void run.refetch()} />;
}
