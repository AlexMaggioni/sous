// A saved workflow: Start at the top right, a banner for a check problem or a change since the
// last yes, the graph, steps, source and changes across the page, then its inputs and last runs
// beside the facts. The view, the selected step and the line Source marks live in the URL.
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { WorkflowPage } from "../../api/contract.ts";
import { useWorkflow } from "../../api/queries.ts";
import { usePageProject, useProjectName, useProjectSearch } from "../../api/seen-from.ts";
import { formatDate, formatDuration, formatAgo, formatFull } from "../../format.ts";
import { Button } from "../../ui/button.tsx";
import { CommandBox } from "../../ui/copy.tsx";
import { Path, type Fact } from "../../ui/facts.tsx";
import { StatusIcon } from "../../ui/status-icon.tsx";
import { Banner, DetailFailed, DetailLoading, DetailPage, isMissing, LINK, None, Section, Stack } from "../detail/detail-page.tsx";
import { WorkflowActions } from "./workflow-actions.tsx";
import { WorkflowViews, type WorkflowView } from "./workflow-views.tsx";
import { approvedBy, cronWords, inputWords, placeWords } from "./workflow-words.ts";

function WorkflowLinks({ names, project }: { names: readonly string[]; project?: string }) {
  const search = useProjectSearch(project);
  if (!names.length) return <None />;
  return (
    <Stack>
      {names.map((name) => (
        <Link key={name} to="/workflows/$name" params={{ name }} search={search} className={LINK}>
          {name}
        </Link>
      ))}
    </Stack>
  );
}

function workflowFacts(w: WorkflowPage, project: string | undefined, projectName: string | undefined): Fact[] {
  const place = placeWords(w.place);
  const cron = w.schedule && cronWords(w.schedule.cron);
  const scheduleInputs = w.schedule?.inputs && Object.keys(w.schedule.inputs).length ? `with ${JSON.stringify(w.schedule.inputs)}` : undefined;
  const facts: Fact[] = [
    w.from === "home"
      ? { label: "Lives in", value: "Home", sub: "Any project can start it" }
      : w.from === "project"
        ? { label: "Lives in", value: projectName ?? "This project" }
        : { label: "Lives in", value: "A file outside the workflow folders" },
    w.startedBy === "people"
      ? { label: "Started by", value: "People only", sub: w.schedule ? "and its schedule" : "Agents get a refusal" }
      : { label: "Started by", value: "People or agents" },
    { label: "Works in", value: place.value, sub: place.sub },
    {
      label: "Schedule",
      value: w.schedule ? cron ?? <code>{w.schedule.cron}</code> : <None />,
      sub: w.schedule && (cron || scheduleInputs) ? (
        <>
          {cron && <code>{w.schedule.cron}</code>}
          {cron && scheduleInputs && ", "}
          {scheduleInputs}
        </>
      ) : undefined,
    },
    { label: "Timeout", value: w.timeout ? <span className="tabular-nums">{w.timeout}</span> : <None /> },
    w.approved
      ? { label: "Approved", value: <span title={formatFull(Date.parse(w.approved.at))}>{formatDate(Date.parse(w.approved.at))}</span>, sub: approvedBy(w.approved) }
      : { label: "Approved", value: <None>Never</None>, sub: "A new file" },
    { label: "File", value: <Path path={w.file} /> },
    { label: "Used by", value: <WorkflowLinks names={w.usedBy} project={project} /> },
  ];
  if (w.calls.length) facts.push({ label: "Starts", value: <WorkflowLinks names={w.calls} project={project} /> });
  // The Inputs section already says a workflow declares no inputs.
  const notes = w.notes.filter((note) => !note.startsWith("declares no inputs"));
  if (notes.length)
    facts.push({
      label: notes.length === 1 ? "Note" : "Notes",
      value: (
        <Stack>
          {notes.map((note) => (
            <span key={note} className="text-pretty">
              {note[0]!.toUpperCase() + note.slice(1)}.
            </span>
          ))}
        </Stack>
      ),
    });
  return facts;
}

/** A check problem first, since it keeps Start off. Then a change with no yes, then nested texts with none. */
function WorkflowBanners({ w, view, onChanges }: { w: WorkflowPage; view: WorkflowView; onChanges: () => void }) {
  const seeChanges = view !== "changes" && (
    <Button size="sm" onClick={onChanges}>
      See what changed
    </Button>
  );
  return (
    <>
      {w.problems.length > 0 && (
        <Banner tone="failed" title={w.problems.length === 1 ? "sous check finds a problem." : `sous check finds ${w.problems.length} problems.`} actions={<CommandBox command={`sous check ${w.name}`} />}>
          {w.problems.length === 1 ? `${w.problems[0]} ` : ""}
          Start stays off until the file passes.
          {w.problems.length > 1 && (
            <ul className="mt-1 list-disc pl-5">
              {w.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </Banner>
      )}
      {w.approved?.changedSince && (
        <Banner tone="needs" title="Changed since you approved it." actions={seeChanges}>
          Agents, other workflows and the schedule start it only once you approve the change. Start shows the change first.
        </Banner>
      )}
      {!w.approved && (
        <Banner tone="needs" title="Never approved." actions={seeChanges}>
          Agents, other workflows and the schedule start it only once you approve its text. Start shows the text first.
        </Banner>
      )}
      {w.waitsOn.length > 0 && (
        <Banner tone="needs" title={`It starts ${w.waitsOn.join(" and ")}, with no yes yet.`}>
          A run that an agent or the schedule starts stops there. Your own start approves {w.waitsOn.length === 1 ? "it" : "them"} too.
        </Banner>
      )}
    </>
  );
}

function Inputs({ w }: { w: WorkflowPage }) {
  if (!w.inputs.length) return <p className="text-muted">It declares no inputs, so it takes any.</p>;
  return (
    <dl className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-6 gap-y-3 max-[699px]:grid-cols-1 max-[699px]:gap-y-1">
      {w.inputs.map((input) => (
        <div key={input.name} className="contents">
          <dt className="pt-px max-[699px]:mt-2">
            <code>{input.name}</code>
          </dt>
          <dd className="min-w-0 text-pretty">
            {input.description}
            <span className={`block text-xs text-muted ${input.description ? "" : "pt-px"}`}>{inputWords(input)}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function LastRuns({ w }: { w: WorkflowPage }) {
  if (!w.lastRuns.length) {
    const first = w.inputs.find((input) => input.required);
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-muted">No runs yet. Start one here, or from a terminal.</p>
        <CommandBox command={`sous run ${w.name}${first ? ` --${first.name} ...` : ""}`} />
      </div>
    );
  }
  return (
    <ul className="-mx-2 flex flex-col">
      {w.lastRuns.map((run) => (
        <li key={run.id}>
          <Link to="/runs/$runId" params={{ runId: run.id }} className="flex h-8 min-w-0 items-center gap-2 rounded-md px-2 no-underline hover:bg-hover max-[699px]:h-10">
            <StatusIcon status={run.status} />
            <span className="min-w-0 truncate font-mono">{run.id}</span>
            <span className="ml-auto flex-none text-xs text-muted tabular-nums">{run.durationMs !== undefined ? formatDuration(run.durationMs) : ""}</span>
            <span className="w-16 flex-none text-right text-xs text-muted tabular-nums" title={formatFull(Date.parse(run.startedAt))}>
              {formatAgo(Date.parse(run.startedAt))}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Loaded({ w, project, projectName }: { w: WorkflowPage; project?: string; projectName?: string }) {
  // The view lives in the URL, so a reload or a shared link opens the same one. A file whose steps
  // sous can't read opens on its text.
  const search = useSearch({ from: "/workflows/$name" });
  const view: WorkflowView = search.view ?? (w.flow ? "graph" : "source");
  const navigate = useNavigate({ from: "/workflows/$name" });
  // The selected step and the project stay as the view changes. The marked line goes once the person leaves Source.
  const setView = (next: WorkflowView) => void navigate({ search: (s) => ({ project: s.project, step: s.step, view: next === "graph" && w.flow ? undefined : next }), replace: true });
  const setStep = (key: string | undefined) => void navigate({ search: (s) => ({ ...s, step: key }), replace: true });
  const showLine = (line: number, flow: string | undefined) => {
    if (flow && flow !== w.name) void navigate({ to: "/workflows/$name", params: { name: flow }, search: (s) => ({ project: s.project, view: "source", line }) });
    else void navigate({ search: (s) => ({ ...s, view: "source", line }), replace: true });
  };
  return (
    <DetailPage
      section="workflows"
      name={w.name}
      description={w.description}
      actions={<WorkflowActions workflow={w} project={project} />}
      banners={<WorkflowBanners w={w} view={view} onChanges={() => setView("changes")} />}
      top={<WorkflowViews workflow={w} project={project} view={view} onView={setView} step={search.step} onStep={setStep} line={search.line} onLine={showLine} />}
      facts={workflowFacts(w, project, projectName)}
    >
      <Section title="Inputs" meta={w.inputs.length || undefined}>
        <Inputs w={w} />
      </Section>
      <Section title="Last runs" meta={w.lastRuns.length || undefined}>
        <LastRuns w={w} />
      </Section>
    </DetailPage>
  );
}

/** One saved workflow, at #/workflows/$name, seen from the project its link names, else the one the lists are seen from. */
export function WorkflowDetail() {
  const { name } = useParams({ from: "/workflows/$name" });
  const project = usePageProject(useSearch({ from: "/workflows/$name" }).project);
  const projectName = useProjectName(project);
  const workflow = useWorkflow(name, project);
  if (workflow.isPending) return <DetailLoading section="workflows" name={name} />;
  if (workflow.data && !isMissing(workflow.error)) return <Loaded key={name} w={workflow.data} project={project} projectName={projectName} />;
  return <DetailFailed section="workflows" name={name} error={workflow.error} retry={() => void workflow.refetch()} seenFrom={projectName} />;
}
