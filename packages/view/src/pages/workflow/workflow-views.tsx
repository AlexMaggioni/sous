// The views of a saved workflow, across the whole page width: the graph, the steps in order, the
// source, and what changed since the last yes. A step selected in the graph or the steps opens its
// panel beside them, which can show its line in the source.
import { Check } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import type { WorkflowPage } from "../../api/contract.ts";
import { useWorkflowDiff } from "../../api/queries.ts";
import { useSend } from "../../api/send.ts";
import { lineCount, plural } from "../../format.ts";
import { planOf } from "../../plan/plan.ts";
import { PlanView } from "../../plan/plan-view.tsx";
import { Button } from "../../ui/button.tsx";
import { CodeFrame, CodeLines } from "../../ui/code-block.tsx";
import { DiffView } from "../../ui/diff-view.tsx";
import { fileName } from "../../ui/facts.tsx";
import { Refusal } from "../../ui/refusal.tsx";
import { Segmented } from "../../ui/segmented.tsx";
import { useArrive } from "../../ui/motion.ts";
import { LoadingRows } from "../../ui/skeleton.tsx";

export type WorkflowView = "graph" | "steps" | "source" | "changes";

/** The file's text. `line` marks one line and scrolls it into view, as a step opened elsewhere asks. */
function SourceView({ file, source, line }: { file: string; source: string; line?: number }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!line || !box.current) return;
    const row = box.current.querySelector<HTMLElement>(`[data-line="${line}"]`);
    if (!row) return;
    row.classList.add("bg-selected");
    row.scrollIntoView?.({ block: "center" });
    return () => row.classList.remove("bg-selected");
  }, [line]);
  const name = fileName(file);
  return (
    <div ref={box}>
      <CodeFrame path={name} meta={plural(lineCount(source), "line")} copy={source}>
        <CodeLines code={source} lang={file} label={`Text of ${name}`} />
      </CodeFrame>
    </div>
  );
}

/** The words that approve the current text of a workflow, as `sous workflows approve` takes them. */
function approveArgv(name: string, project: string | undefined): string[] {
  return ["workflows", "approve", name, ...(project ? ["--project", project] : [])];
}

/** What changed since the last yes, and the button that approves the text as it is now. */
function ChangesView({ workflow, project, onApproved }: { workflow: WorkflowPage; project?: string; onApproved: () => void }) {
  const diff = useWorkflowDiff(workflow.name, project);
  const { send, error, pending } = useSend();
  const approve = async () => {
    if (await send(approveArgv(workflow.name, project), () => `Approved ${workflow.name}`)) onApproved();
  };
  if (diff.isPending) return <LoadingRows label="Loading the changes" rows={6} rowHeight={28} />;
  if (diff.error) return <Refusal error={diff.error} action={<Button size="sm" onClick={() => void diff.refetch()}>Try again</Button>} />;
  return (
    <div className="flex flex-col gap-3">
      <DiffView diff={diff.data} path={fileName(workflow.file)} />
      <p className="max-w-[40em] text-pretty text-muted">
        {workflow.approved ? "Agents, other workflows and the schedule start only the text you approved. " : "Agents, other workflows and the schedule can't start it until you approve it. "}
        Approve says yes to the text as it is now. Starting it yourself does the same.
      </p>
      {error !== null && <Refusal error={error} />}
      <div>
        <Button icon={Check} onClick={approve} busy={pending}>
          Approve
        </Button>
      </div>
    </div>
  );
}

export type ViewsProps = {
  workflow: WorkflowPage;
  project?: string;
  view: WorkflowView;
  onView: (view: WorkflowView) => void;
  /** The selected step, by its key in the plan. */
  step?: string;
  onStep: (key: string | undefined) => void;
  /** The line Source marks, after a step's panel showed it. */
  line?: number;
  /** Shows a line: in this text, or in the text of the nested workflow it names. */
  onLine: (line: number, flow: string | undefined) => void;
};

const UNREAD = <p className="text-muted">sous could not read the steps of this file. Source shows its text.</p>;

/** The switch, then the view it picks. Changes shows only when the text has no yes for what it is now. */
export function WorkflowViews({ workflow, project, view, onView, step, onStep, line, onLine }: ViewsProps) {
  const unapproved = !workflow.approved || workflow.approved.changedSince;
  const options = [
    { value: "graph" as const, label: "Graph" },
    { value: "steps" as const, label: "Steps" },
    { value: "source" as const, label: "Source" },
    ...(unapproved ? [{ value: "changes" as const, label: "Changes" }] : []),
  ];
  const shown: WorkflowView = view === "changes" && !unapproved ? "graph" : view;
  const flow = workflow.flow;
  const plan = useMemo(() => planOf(flow, undefined), [flow]);
  // Source or Changes arrives like a new page. Graph and Steps share the plan, which plays it on its view.
  const box = useRef<HTMLDivElement>(null);
  useArrive(box, shown === "graph" || shown === "steps" ? "plan" : shown);
  return (
    <div>
      <Segmented label="View" value={shown} onChange={onView} options={options} />
      <div ref={box} className="mt-3">
        {(shown === "graph" || shown === "steps") &&
          (flow ? (
            <PlanView
              view={shown}
              plan={plan}
              flow={flow}
              now={0}
              selected={step}
              onSelect={onStep}
              label={`Graph of ${workflow.name}`}
              project={project}
              file={fileName(workflow.file)}
              onLine={onLine}
              empty={UNREAD}
            />
          ) : (
            UNREAD
          ))}
        {shown === "source" && <SourceView file={workflow.file} source={workflow.source} line={line} />}
        {shown === "changes" && <ChangesView workflow={workflow} project={project} onApproved={() => onView("graph")} />}
      </div>
    </div>
  );
}
