// Start one workflow: fill its inputs, see what changed since the last yes when it did, then run it
// through sous run. The person's own start approves the text it runs, as at the terminal, so the
// change shows first and the button says so.
import { useNavigate } from "@tanstack/react-router";
import { Play } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { Input, WorkflowPage } from "../api/contract.ts";
import { useOverview, useWorkflow, useWorkflowDiff } from "../api/queries.ts";
import { useSeenFrom } from "../api/seen-from.ts";
import { commandOf, useSend } from "../api/send.ts";
import { Banner, isMissing } from "../pages/detail/detail-page.tsx";
import { startBlocked } from "../pages/workflow/workflow-actions.tsx";
import { Button } from "../ui/button.tsx";
import { CommandBox } from "../ui/copy.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { DiffView } from "../ui/diff-view.tsx";
import { CheckboxInput, Field, SelectInput, TextArea, TextInput } from "../ui/field.tsx";
import { fileName } from "../ui/facts.tsx";
import { Refusal } from "../ui/refusal.tsx";
import { LoadingRows, Skel } from "../ui/skeleton.tsx";
import { closeStart, openStart } from "./start-store.ts";
import { checkValues, initialValues, startArgv, type Values } from "./start-words.ts";

/** The muted word after an input's name: required, its default, or optional. */
function noteOf(input: Input): string {
  if (input.required) return "required";
  if (input.default !== undefined) return `default ${JSON.stringify(input.default)}`;
  return "optional";
}

/** One input, with the control its type asks for. Each change goes to `onChange` under the input's name. */
function StartField({ input, value, error, first, onChange }: { input: Input; value: string | boolean; error?: string; first: boolean; onChange: (value: string | boolean) => void }) {
  const name = <code className="font-mono text-xs font-normal">{input.name}</code>;
  if (input.type === "boolean") {
    const id = `start-in-${input.name}`;
    return (
      <div role="group" aria-labelledby={id} className="min-w-0">
        <p id={id} className="flex items-baseline gap-2 font-medium">
          {name}
          <span className="text-xs font-normal text-muted">{noteOf(input)}</span>
        </p>
        <div className="mt-1.5">
          <CheckboxInput checked={value === true} onCheckedChange={onChange}>
            {input.description ?? input.name}
          </CheckboxInput>
        </div>
      </div>
    );
  }
  const text = typeof value === "string" ? value : "";
  return (
    <Field label={name} note={noteOf(input)} description={input.description} error={error}>
      {input.choices?.length ? (
        <SelectInput options={input.choices} defaultValue={text || undefined} onValueChange={onChange} required={input.required} />
      ) : input.type === "json" ? (
        <TextArea mono value={text} onValueChange={onChange} required={input.required} autoFocus={first} data-autofocus={first || undefined} submitShortcut="mod+enter" placeholder='{"key": "value"}' />
      ) : (
        <TextInput
          type="text"
          inputMode={input.type === "number" ? "decimal" : undefined}
          mono={input.type === "number"}
          value={text}
          onValueChange={onChange}
          required={input.required}
          autoFocus={first}
          data-autofocus={first || undefined}
        />
      )}
    </Field>
  );
}

/** Where a home workflow runs. A project workflow runs in its own project, so it has no pick. */
function ProjectPick({ value, onChange }: { value: string | undefined; onChange: (dir: string) => void }) {
  const overview = useOverview().data;
  if (!overview || overview.projects.length < 2) return null;
  return (
    <Field label="Project" description="The folder the run works in. This workflow lives in the home, so any project can run it.">
      <SelectInput options={overview.projects.map((p) => ({ value: p.dir, label: `${p.name}, ${p.dir}` }))} defaultValue={value ?? overview.project.dir} onValueChange={onChange} />
    </Field>
  );
}

function Notes({ w }: { w: WorkflowPage }) {
  return (
    <>
      {w.problems.length > 0 && (
        <Banner tone="failed" title="sous check finds a problem." actions={<CommandBox command={`sous check ${w.name}`} />}>
          {w.problems.join(" ")} Fix the file, then start it.
        </Banner>
      )}
      {(!w.approved || w.approved.changedSince) && w.problems.length === 0 && (
        <Banner tone="needs" title={w.approved ? "Changed since you approved it." : "Never approved."}>
          Start shows the {w.approved ? "change" : "text"} before it runs.
        </Banner>
      )}
      {w.startedBy === "people" && <p className="mt-4 text-muted">Only people start {w.name}. You start it here, so the run shows you as the one who started it.</p>}
    </>
  );
}

/** What changed since the last yes, before the run starts. */
function Review({ w, project }: { w: WorkflowPage; project?: string }) {
  const diff = useWorkflowDiff(w.name, project);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-pretty">
        {w.approved ? "The file changed since you approved it. Read the change, then start." : "You never approved this file. Read it, then start."}
      </p>
      {diff.isPending && <LoadingRows label="Loading the changes" rows={5} rowHeight={28} />}
      {diff.error && <Refusal error={diff.error} action={<Button size="sm" onClick={() => void diff.refetch()}>Try again</Button>} />}
      {diff.data && <DiffView diff={diff.data} path={fileName(w.file)} />}
      <p className="text-pretty text-muted">
        Starting approves this text for later runs, as your own sous run does
        {w.waitsOn.length ? `. It approves ${w.waitsOn.join(" and ")} too, which it starts.` : "."}
      </p>
    </div>
  );
}

function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading the workflow" className="flex flex-col gap-4 pt-1">
      {["w-24", "w-32"].map((w) => (
        <div key={w}>
          <Skel className={`h-4 ${w}`} />
          <Skel className="mt-2 h-8 w-full" />
        </div>
      ))}
    </div>
  );
}

/** The dialog for one workflow, from loading to started. `open` turns false as it closes. */
export function StartForm({ name, open }: { name: string; open: boolean }) {
  const navigate = useNavigate();
  const project = useSeenFrom();
  const query = useWorkflow(name, project);
  const w = query.data && !isMissing(query.error) ? query.data : undefined;
  const unapproved = !!w && (!w.approved || w.approved.changedSince);
  // Ask for the diff as soon as the form opens, so the review shows at once.
  useWorkflowDiff(name, project, unapproved);
  const { send, error, clear, pending } = useSend();
  const formId = useId();
  const form = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<Values | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [step, setStep] = useState<"fill" | "review">("fill");
  const [picked, setPicked] = useState<string>();
  const [tries, setTries] = useState(0);
  if (w && values === null) setValues(initialValues(w.inputs));

  // After a check fails, focus goes to the first field it names.
  useEffect(() => {
    if (tries) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [tries]);

  const runIn = w?.from === "home" ? (picked ?? project) : project;
  const argv = w && values ? startArgv(w.name, runIn, w.inputs, values) : undefined;
  const blocked = w ? startBlocked(w) : "Loading the workflow";

  const run = async () => {
    if (!w || !argv) return;
    const reply = await send(argv, () => `Started ${w.name}`);
    if (!reply) return;
    closeStart();
    const runId = reply.data.runId;
    if (typeof runId === "string") void navigate({ to: "/runs/$runId", params: { runId } });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!w || !values || blocked || pending) return;
    const found = checkValues(w.inputs, values);
    setErrors(found);
    if (Object.keys(found).length) {
      setTries((n) => n + 1);
      return;
    }
    if (unapproved && step === "fill") {
      clear();
      setStep("review");
      return;
    }
    void run();
  };

  const set = (key: string) => (value: string | boolean) => {
    setValues((v) => ({ ...v, [key]: value }));
    if (errors[key]) setErrors(({ [key]: _gone, ...rest }) => rest);
  };

  const missing = isMissing(query.error);
  const fields = w?.inputs ?? [];
  // The dialog focuses what carries data-autofocus as it opens; React's autoFocus covers a step change.
  const startFirst = !!w && !fields.length && w.from !== "home";
  // Start is already there while the workflow loads, so it takes the focus once the workflow is in.
  useEffect(() => {
    if (!open || !startFirst) return;
    const frame = requestAnimationFrame(() => form.current?.ownerDocument.querySelector<HTMLElement>(`button[form="${CSS.escape(formId)}"]`)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, startFirst, formId]);
  const actions =
    step === "review" ? (
      <>
        <Button variant="quiet" onClick={() => setStep("fill")}>
          Back
        </Button>
        <Button variant="primary" icon={Play} type="submit" form={formId} busy={pending} autoFocus data-autofocus>
          Approve and start
        </Button>
      </>
    ) : (
      <>
        <Button variant="quiet" onClick={closeStart}>
          Cancel
        </Button>
        {missing ? (
          <Button variant="primary" onClick={() => openStart()}>
            Pick another
          </Button>
        ) : (
          <Button variant="primary" icon={Play} type="submit" form={formId} busy={pending} disabled={query.error ? "The workflow did not load" : blocked} autoFocus={startFirst} data-autofocus={startFirst || undefined}>
            Start
          </Button>
        )}
      </>
    );

  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeStart()} title={`Start ${name}`} description={w?.description} actions={actions} wide={step === "review"}>
      <form id={formId} ref={form} noValidate onSubmit={submit}>
        {query.isPending && <Loading />}
        {missing && <p className="text-pretty">sous finds no workflow named {name}. It was moved or removed. Pick another to start.</p>}
        {query.error && !missing && !w && <Refusal error={query.error} action={<Button size="sm" onClick={() => void query.refetch()}>Try again</Button>} />}
        {w && values && step === "fill" && (
          <div className="flex flex-col gap-4">
            <div className="-mt-4 empty:hidden">
              <Notes w={w} />
            </div>
            {w.from === "home" && <ProjectPick value={picked ?? project} onChange={setPicked} />}
            {fields.map((input, i) => (
              <StartField key={input.name} input={input} value={values[input.name] ?? ""} error={errors[input.name]} first={i === 0} onChange={set(input.name)} />
            ))}
            {fields.length === 0 && w.problems.length === 0 && <p className="text-muted">It declares no inputs, so Start sends none.</p>}
            {argv && (
              <div>
                <p className="text-xs text-muted">The same start from a terminal</p>
                <div className="mt-1">
                  <CommandBox command={commandOf(argv)} />
                </div>
              </div>
            )}
          </div>
        )}
        {w && step === "review" && <Review w={w} project={project} />}
        {error !== null && (
          <div className="mt-4">
            <Refusal error={error} />
          </div>
        )}
      </form>
    </Dialog>
  );
}
