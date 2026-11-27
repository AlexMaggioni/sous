// What a run did with a step, in the step's panel: first what the person can do about it, such as
// answering its question or resuming from its failure, then what it did, then what the step is,
// with its status, time and tokens beside. A step that ran more than once, such as in each round of
// a loop, switches between its calls. It reads the call only while the panel shows it.
import { ChevronLeft, ChevronRight, Play, Send } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import type { Question, RunPage, Step, StepDetail, StepSession } from "../../api/contract.ts";
import { useStep } from "../../api/queries.ts";
import { commandOf, useSend } from "../../api/send.ts";
import { clock, formatCost, formatDate, formatDuration, formatFull, formatTokens, lineCount, plural } from "../../format.ts";
import type { Leaf } from "../../graph/tree.ts";
import { PanelPart, Pairs, type About } from "../../plan/step-about.tsx";
import { PanelColumns } from "../../plan/step-panel.tsx";
import { Button, IconButton } from "../../ui/button.tsx";
import { CodeFrame, CodeLines } from "../../ui/code-block.tsx";
import { CommandBox } from "../../ui/copy.tsx";
import { TextInput } from "../../ui/field.tsx";
import { Fold } from "../../ui/fold.tsx";
import { MarkdownBlock } from "../../ui/markdown.tsx";
import { Refusal } from "../../ui/refusal.tsx";
import { LoadingRows } from "../../ui/skeleton.tsx";
import { STATUS_LABEL, StatusIcon } from "../../ui/status-icon.tsx";
import { ActivityList } from "./activity.tsx";
import { QuestionPanel } from "./needs-you.tsx";
import { FLAG_TEXT, readsAsFlag, resumeFor, words } from "./run-words.ts";
import { stepDuration } from "./time-axis.ts";

/** A step's time as a clock, 14:05:09, with the date before it when it is not today. The full date is in its title. */
function at(time: string | undefined): ReactNode {
  if (!time) return undefined;
  const date = new Date(time);
  const today = date.toDateString() === new Date().toDateString();
  return (
    <time dateTime={time} title={formatFull(date)}>
      {today ? clock(date) : `${formatDate(date)}, ${clock(date)}`}
    </time>
  );
}

/** A code block named for what it holds, such as "Output of check disk", so a screen reader tells them apart. */
function NamedCode({ code, label, lang }: { code: string; label: string; lang?: string }) {
  return (
    <CodeFrame meta={plural(lineCount(code), "line")} copy={code}>
      <CodeLines code={code} lang={lang} wrap label={label} />
    </CodeFrame>
  );
}

/** What a code step returned, as JSON when it is JSON. */
function resultText(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result !== "string") return JSON.stringify(result, null, 2);
  try {
    return JSON.stringify(JSON.parse(result), null, 2);
  } catch {
    return result;
  }
}

/** Sends a message to a running agent step, which reads it after its current tool call. */
function Tell({ run, step, calls }: { run: RunPage; step: Step; calls: number }) {
  const { send, error } = useSend();
  const [text, setText] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || readsAsFlag(text)) return;
    const argv = words.tell(run.id, step.name, text, calls > 1 ? step.call : undefined);
    const reply = await send(argv, (r) => (r.data.delivery === "pending" ? `Sent to ${step.label}, not read yet` : `Told ${step.label}`));
    if (reply) setText("");
  };
  return (
    <form onSubmit={submit} className="max-w-[70ch]">
      <label htmlFor={`tell-${step.key}`} className="mb-1.5 block text-xs font-medium text-muted">
        Tell {step.label}
      </label>
      <div className="flex gap-2">
        <TextInput id={`tell-${step.key}`} value={text} onChange={(e) => setText(e.currentTarget.value)} placeholder="It reads this after its current tool call" />
        <Button type="submit" icon={Send} disabled={!text.trim() ? "Write a message first." : readsAsFlag(text) ? FLAG_TEXT : false}>
          Tell
        </Button>
      </div>
      {error !== null && (
        <div className="mt-2">
          <Refusal error={error} />
        </div>
      )}
    </form>
  );
}

/** The error first, and "Resume from here" when the run can go on from it. */
function FailedFirst({ run, step, detail, primary }: { run: RunPage; step: Step; detail?: StepDetail; primary: boolean }) {
  const { send, error } = useSend();
  const argv = resumeFor(run);
  return (
    <div>
      <div className="border-l-[3px] border-fail py-1 pl-3">
        <p className="font-medium [overflow-wrap:anywhere]">{detail?.failure ?? step.error ?? "The step failed."}</p>
      </div>
      {run.can.resume && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Button variant={primary ? "primary" : "secondary"} icon={Play} onClick={() => send(argv, () => `Resumed from ${step.label}`)}>
            Resume from here
          </Button>
          <CommandBox command={commandOf(argv)} />
        </div>
      )}
      {error !== null && (
        <div className="mt-2">
          <Refusal error={error} />
        </div>
      )}
    </div>
  );
}

/** "Call 2 of 3", with a button to each side. */
function CallSwitch({ index, count, onPick }: { index: number; count: number; onPick: (i: number) => void }) {
  return (
    <div role="group" aria-label="Calls" className="-ml-1.5 flex items-center gap-1 text-xs text-muted">
      <IconButton icon={ChevronLeft} size="sm" label="Earlier call" disabled={index === 0 ? "This is the first call" : false} onClick={() => onPick(index - 1)} />
      <span aria-live="polite" className="tabular-nums">
        Call {index + 1} of {count}
      </span>
      <IconButton icon={ChevronRight} size="sm" label="Later call" disabled={index === count - 1 ? "This is the latest call" : false} onClick={() => onPick(index + 1)} />
    </div>
  );
}

function CallFacts({ step, detail, now }: { step: Step; detail?: StepDetail; now: number }) {
  const duration = stepDuration(step, now);
  const usage = step.usage;
  return (
    <Pairs
      pairs={[
        ["Status", <span className="inline-flex items-center gap-1.5"><StatusIcon status={step.status} label={false} />{STATUS_LABEL[step.status]}</span>],
        ["Started", at(step.startedAt) ?? "Not yet"],
        ["Duration", duration === undefined ? undefined : formatDuration(duration)],
        ["Model", detail?.model ?? step.model],
        !!step.tries && step.tries > 1 && ["Tries", String(step.tries)],
        ["Input", usage ? formatTokens(usage.input) : undefined],
        ["Output", usage ? formatTokens(usage.output) : undefined],
        ["Cache read", usage?.cacheRead ? formatTokens(usage.cacheRead) : undefined],
        ["Tokens", !usage && step.tokens ? formatTokens(step.tokens) : undefined],
        ["Cost", usage ? formatCost(usage.cost) : undefined],
      ]}
    />
  );
}

/** The agent's session: its program, id and folder, and the command that steps into it in a terminal. */
function StepSessionPart({ session }: { session: StepSession }) {
  return (
    <div className="flex flex-col gap-2 text-xs">
      <Pairs
        pairs={[
          ["Program", session.program],
          ["Id", <code className="font-mono [overflow-wrap:anywhere]">{session.id}</code>],
          ["Handle", session.handle],
          ["Folder", <code className="font-mono [overflow-wrap:anywhere]">{session.folder}</code>],
        ]}
      />
      <p className="text-muted">Step into it in a terminal. The step's next turn waits until you leave.</p>
      <div>
        <CommandBox command={session.join} label="Copy the join command" />
      </div>
    </div>
  );
}

/** What the call did: the agent's activity, or the command's output and result, then the prompt as sent. */
function CallDetail({ step, detail, source }: { step: Step; detail: StepDetail; source?: string }) {
  const live = step.status === "running";
  const result = detail.kind === "exec" ? resultText(detail.result) : undefined;
  // The command shows here only when the run filled something into the step's code. Otherwise the code below says it.
  const command = detail.command && detail.command.trim() !== source?.trim() ? detail.command : undefined;
  return (
    <>
      {detail.kind === "agent" && (
        <PanelPart title="Activity">
          <ActivityList key={`${step.key} ${step.call}`} activity={detail.activity} live={live} empty={live ? "No activity yet. Lines show here as the agent works." : "No activity."} />
        </PanelPart>
      )}
      {detail.session && (
        <PanelPart title="Session">
          <StepSessionPart session={detail.session} />
        </PanelPart>
      )}
      {command && (
        <PanelPart title="Command as it ran">
          <NamedCode code={command} label={`Command of ${step.label}`} />
        </PanelPart>
      )}
      {detail.kind === "exec" && (
        <PanelPart title="Output">{detail.output ? <NamedCode code={detail.output} label={`Output of ${step.label}`} /> : <p className="text-xs text-muted">No output.</p>}</PanelPart>
      )}
      {result && (
        <PanelPart title="Result">
          <NamedCode code={result} label={`Result of ${step.label}`} lang="json" />
        </PanelPart>
      )}
      {detail.prompt && (
        <div className="mt-5">
          <Fold title={<span className="text-xs font-medium text-muted">Prompt as sent</span>}>
            <MarkdownBlock path="prompt" text={detail.prompt} />
          </Fold>
        </div>
      )}
    </>
  );
}

export type StepCallProps = {
  run: RunPage;
  leaf: Leaf;
  now: number;
  /** "Resume from here" is the page's one primary, when the step is the failed one. */
  primary: boolean;
  onSelect: (key: string) => void;
  /** What the step is, which shows after what it did, and its settings, which show beside. */
  about: About;
  /** The step's code as the text writes it, so the command as it ran shows only when it differs. */
  source?: string;
  /** Hears of an answer given in the panel that lets the run go on. */
  onPassed?: (question: Question) => void;
};

/** The run's side of a step's panel. Key it by the part, so another step starts at its latest call. */
export function StepCall({ run, leaf, now, primary, onSelect, about, source, onPassed }: StepCallProps) {
  const calls = (leaf.calls ?? (leaf.step ? [leaf.step] : [])).map((k) => run.steps.find((s) => s.key === k)).filter((s): s is Step => !!s);
  const [pick, setPick] = useState<number>();
  const index = Math.min(pick ?? calls.length - 1, calls.length - 1);
  const step = calls[index];
  const detail = useStep(run.id, step?.name ?? "", step?.call, !!step);
  const question = leaf.ask ? run.questions.find((q) => q.id === leaf.ask) : undefined;
  const latest = index === calls.length - 1;
  const asked = question && latest;
  const lead = (asked || step?.status === "failed" || step?.status === "running" || calls.length > 1 || !step) && (
    <div className="flex flex-col gap-5">
      {asked && <QuestionPanel run={run} question={question} primary={false} onOpenStep={onSelect} onAnswered={(a) => a.goesOn && onPassed?.(a.question)} inPanel named={leaf.label} />}
      {step?.status === "failed" && <FailedFirst run={run} step={step} detail={detail.data} primary={primary} />}
      {step && step.status === "running" && step.kind === "agent" && <Tell run={run} step={step} calls={detail.data?.calls ?? 1} />}
      {calls.length > 1 && <CallSwitch index={index} count={calls.length} onPick={setPick} />}
      {!step && !question && <p className="text-muted">{leaf.status === "skipped" ? "It didn't run. The run ended first, or its branch didn't run." : leaf.status === "done" ? "Answered, and the run went on." : "It hasn't run yet."}</p>}
    </div>
  );
  const did =
    step &&
    (detail.isPending ? (
      <LoadingRows label={`Loading ${step.label}`} rows={4} rowHeight={28} />
    ) : detail.isError ? (
      <Refusal
        error={detail.error}
        action={
          <Button size="sm" onClick={() => detail.refetch()}>
            Try again
          </Button>
        }
      />
    ) : (
      <CallDetail step={step} detail={detail.data} source={source} />
    ));
  return <PanelColumns lead={lead} facts={step && <CallFacts step={step} detail={detail.data} now={now} />} did={did} is={about.main} side={about.side} />;
}
