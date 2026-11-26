// What needs the person: one panel per open question, between the header and the views, with a
// copper edge, who asks and from which step, the question, and the controls for its kind. Once
// answered, the answer stays where the question was.
import { Check } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Question, RunPage, Step } from "../../api/contract.ts";
import { useStep } from "../../api/queries.ts";
import { commandOf, useSend } from "../../api/send.ts";
import { Button } from "../../ui/button.tsx";
import { CommandBox } from "../../ui/copy.tsx";
import { Field, TextArea } from "../../ui/field.tsx";
import { Fold } from "../../ui/fold.tsx";
import { Markdown } from "../../ui/markdown.tsx";
import { Refusal } from "../../ui/refusal.tsx";
import { RelativeTime } from "../../ui/relative-time.tsx";
import { LoadingRows } from "../../ui/skeleton.tsx";
import { StatusIcon } from "../../ui/status-icon.tsx";
import { ActivityList } from "./activity.tsx";
import { FLAG_TEXT, askedOf, readsAsFlag, words } from "./run-words.ts";

/** An answer the person gave on this page, kept while they stay on the run. */
interface Answered {
  question: Question;
  /** What the answer did, in a sentence, such as `You answered "World". The run goes on.` */
  said: string;
  command: string;
  /** The answer lets the run go on past the question. A send back, a stop or a paused run does not. */
  goesOn: boolean;
}

/**
 * Sends an answer. `said` stays where the question was, followed by `then`, what happens next, and
 * `toast` names it in the button's verb.
 */
type Answer = (argv: string[], said: string, toast: string, then?: string) => Promise<void>;

/** The controls of one kind of question. `sending` is set while an answer is on its way, so no second one goes. */
type AnswerProps = { question: Question; primary: boolean; answer: Answer; sending: boolean };

/** Why the controls are off while an answer is on its way. */
const SENDING = "Your answer is on its way.";

const GOES_ON = "The run goes on.";
/** An answer to a paused run waits for the resume, so the page doesn't say the run goes on. */
const STAYS_PAUSED = "The run is paused, so it uses the answer once you resume it.";

/** The step that asks: the latest call of that name in the run that asks. */
function askingStep(run: RunPage, question: Question): Step | undefined {
  if (!question.step) return undefined;
  const calls = run.steps.filter((s) => (s.name === question.step || s.label === question.step) && s.scope === question.scope);
  return calls[calls.length - 1] ?? [...run.steps].reverse().find((s) => s.name === question.step);
}

/** Cmd or Ctrl and Enter sends a text area's form. */
function sendOnModEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }
}

/** A text answer, sent with Answer or with Cmd and Enter. */
function InputAnswer({ question, primary, answer, sending }: AnswerProps) {
  const [text, setText] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim()) void answer(words.answer(question.id, text), `You answered "${text}".`, "Answer sent");
  };
  return (
    <form onSubmit={submit} className="mt-3 flex max-w-[560px] flex-col gap-2">
      <Field label="Your answer">
        <TextArea value={text} onChange={(e) => setText(e.currentTarget.value)} onKeyDown={sendOnModEnter} rows={2} />
      </Field>
      <div>
        <Button type="submit" variant={primary ? "primary" : "secondary"} disabled={sending ? SENDING : text.trim() ? false : "Write an answer first."}>
          Answer
        </Button>
      </div>
    </form>
  );
}

/** One of the question's choices, picked with radios and sent with Answer. */
function SelectAnswer({ question, primary, answer, sending }: AnswerProps) {
  const [choice, setChoice] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (choice !== null) void answer(words.answer(question.id, choice), `You answered "${choice}".`, "Answer sent");
  };
  return (
    <form onSubmit={submit} className="mt-3">
      <fieldset className="flex flex-col">
        <legend className="sr-only">{question.prompt}</legend>
        {(question.choices ?? []).map((c) => (
          <label key={c} className="flex min-h-7 w-fit cursor-pointer items-center gap-2 max-[699px]:min-h-10">
            <input type="radio" name={`choice-${question.id}`} value={c} checked={choice === c} onChange={() => setChoice(c)} className="m-0 size-4 accent-ink" />
            {c}
          </label>
        ))}
      </fieldset>
      <div className="mt-2">
        <Button type="submit" variant={primary ? "primary" : "secondary"} disabled={sending ? SENDING : choice === null ? "Pick a choice first." : false}>
          Answer
        </Button>
      </div>
    </form>
  );
}

function ConfirmAnswer({ question, primary, answer, sending }: AnswerProps) {
  const off = sending ? SENDING : false;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      <Button variant={primary ? "primary" : "secondary"} disabled={off} onClick={() => answer(words.answer(question.id, "yes"), "You answered yes.", "Answered yes")}>
        Yes
      </Button>
      <Button disabled={off} onClick={() => answer(words.answer(question.id, "no"), "You answered no.", "Answered no")}>
        No
      </Button>
    </div>
  );
}

/** Approve, send back with a note, or stop the run. */
function BreakpointAnswer({ question, primary, answer, sending }: AnswerProps) {
  const [back, setBack] = useState(false);
  const [note, setNote] = useState("");
  const noteRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (back) noteRef.current?.focus();
  }, [back]);
  const sendBack = (event: FormEvent) => {
    event.preventDefault();
    if (note.trim() && !readsAsFlag(note)) void answer(words.sendBack(question.id, note), `You sent it back with "${note}".`, "Sent back", "The steps inside run again.");
  };
  const off = sending ? SENDING : false;
  return (
    <>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant={primary ? "primary" : "secondary"} disabled={off} onClick={() => answer(words.approve(question.id), "You approved it.", "Approved")}>
          Approve
        </Button>
        <Button aria-expanded={back} onClick={() => setBack(!back)}>
          Send back
        </Button>
        <Button variant="quiet" disabled={off} onClick={() => answer(words.stopAt(question.id), "You stopped the run.", `Stopped ${question.runId}`, "")}>
          Stop the run
        </Button>
      </div>
      {back && (
        <form onSubmit={sendBack} className="mt-3 flex max-w-[560px] flex-col gap-2">
          <Field label="What should change?" description="The steps inside run again with your note.">
            <TextArea ref={noteRef} value={note} onChange={(e) => setNote(e.currentTarget.value)} onKeyDown={sendOnModEnter} rows={2} />
          </Field>
          <div>
            <Button type="submit" disabled={sending ? SENDING : !note.trim() ? "Write a note first." : readsAsFlag(note) ? FLAG_TEXT : false}>
              Send back
            </Button>
          </div>
        </form>
      )}
    </>
  );
}

/** What the asking agent did before it asked: its last lines, read only once opened. */
function BeforeAsking({ run, step }: { run: RunPage; step: Step }) {
  const [open, setOpen] = useState(false);
  const detail = useStep(run.id, step.name, step.call, open);
  return (
    <div className="mt-2 max-w-[760px] text-xs">
      <Fold title={<span className="font-normal text-muted">What {step.label} did before asking</span>} open={open} onOpenChange={setOpen}>
        {detail.isPending ? <LoadingRows label="Loading the activity" rows={3} rowHeight={28} /> : detail.isError ? <Refusal error={detail.error} /> : <ActivityList activity={detail.data.activity.slice(-6)} live={false} />}
      </Fold>
    </div>
  );
}

/**
 * A question and its answer form. In a step's panel, the panel's header already names the step,
 * so the question drops its bar, its kind, and its title when the header says the same.
 */
export function QuestionPanel({
  run,
  question,
  primary,
  onOpenStep,
  onAnswered,
  inPanel = false,
  named,
  arrived = false,
}: {
  run: RunPage;
  question: Question;
  primary: boolean;
  onOpenStep: (key: string) => void;
  onAnswered: (answered: Answered) => void;
  inPanel?: boolean;
  /** The name the panel's header shows. */
  named?: string;
  /** Asked while the run showed, so it rises in, once the views under it have nearly made room. */
  arrived?: boolean;
}) {
  const { send, error } = useSend();
  const asked = askedOf(question);
  const step = askingStep(run, question);
  const nested = question.scope !== run.id ? run.nested.find((n) => n.id === question.scope) : undefined;
  // One answer at a time. The ref holds at once, before the page draws the controls as off.
  const [sending, setSending] = useState(false);
  const busy = useRef(false);
  const answer: Answer = async (argv, said, toast, then = GOES_ON) => {
    if (busy.current) return;
    busy.current = true;
    setSending(true);
    const reply = await send(argv, () => toast);
    busy.current = false;
    setSending(false);
    if (!reply) return;
    const next = then && reply.data.running === false ? STAYS_PAUSED : then;
    onAnswered({ question, said: next ? `${said} ${next}` : said, command: commandOf(argv), goesOn: next === GOES_ON });
  };
  const id = `${inPanel ? "panel-" : ""}question-${question.id}`;
  const props = { question, primary, answer, sending };
  return (
    <section aria-labelledby={id} className={`${inPanel ? "max-w-[70ch]" : "mt-6 border-l-[3px] border-needs py-1 pl-4"} ${arrived ? "animate-arrive-late" : ""}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        {!inPanel && <StatusIcon status="needs" label={false} />}
        {!inPanel && <span className="text-fg">{asked.who}</span>}
        {step && !inPanel && (
          <span>
            from{" "}
            <button type="button" onClick={() => onOpenStep(step.key)} className="rounded-sm font-mono underline decoration-1 underline-offset-2">
              {step.label}
            </button>
          </span>
        )}
        {nested && <span>in {nested.label ?? nested.workflow}</span>}
        <span>
          {inPanel ? "Asked" : "asked"} <RelativeTime at={question.askedAt} />
        </span>
      </div>
      <h2 id={id} className={inPanel && asked.title === named ? "sr-only" : "mt-1.5 max-w-[36em] text-md [overflow-wrap:anywhere]"}>
        {asked.title}
      </h2>
      {asked.show && (
        <div className="mt-3 max-w-[760px] overflow-hidden rounded-lg border border-line bg-raised">
          <p className="flex min-h-8 items-center border-b border-line px-3 text-xs text-muted">What it shows for review</p>
          <div className="px-4 pt-1 pb-3">
            <Markdown>{asked.show}</Markdown>
          </div>
        </div>
      )}
      {step && step.kind === "agent" && <BeforeAsking run={run} step={step} />}
      {question.breakpoint ? <BreakpointAnswer {...props} /> : question.kind === "confirm" ? <ConfirmAnswer {...props} /> : question.kind === "select" && question.choices?.length ? <SelectAnswer {...props} /> : <InputAnswer {...props} />}
      {error !== null && (
        <div className="mt-3">
          <Refusal error={error} />
        </div>
      )}
    </section>
  );
}

/** The answer, where the question was. It takes focus, so a screen reader says it and Tab goes on from here. */
function AnsweredNote({ answered, focus, run, onOpenStep }: { answered: Answered; focus: boolean; run: RunPage; onOpenStep: (key: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus]);
  const { question } = answered;
  const step = askingStep(run, question);
  return (
    <div ref={ref} tabIndex={-1} role="status" className="mt-6 flex animate-arrive items-start gap-2 border-l-[3px] border-line-strong py-1 pl-4">
      <Check size={16} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 flex-none text-icon" />
      <div className="max-w-[36em] min-w-0">
        <p className="text-muted [overflow-wrap:anywhere]">{askedOf(question).title}</p>
        <p className="[overflow-wrap:anywhere]">{answered.said}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <CommandBox command={answered.command} />
          {step && (
            <Button variant="quiet" size="sm" onClick={() => onOpenStep(step.key)}>
              Show the step
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Every open question of the run, oldest first, and the answers given here in their place.
 * `onPassed` hears of each answer that lets the run go on.
 */
export function NeedsYou({ run, onOpenStep, onPassed }: { run: RunPage; onOpenStep: (key: string) => void; onPassed?: (question: Question) => void }) {
  const [answered, setAnswered] = useState<Answered[]>([]);
  const [last, setLast] = useState<string | null>(null);
  useEffect(() => {
    setAnswered([]);
    setLast(null);
  }, [run.id]);
  // The questions open when the run showed first. One asked later rises in.
  const [base, setBase] = useState(() => ({ run: run.id, ids: new Set(run.questions.map((q) => q.id)) }));
  if (base.run !== run.id) setBase({ run: run.id, ids: new Set(run.questions.map((q) => q.id)) });
  const known = base.run === run.id ? base.ids : new Set(run.questions.map((q) => q.id));
  const done = new Set(answered.map((a) => a.question.id));
  const open = run.questions.filter((q) => !done.has(q.id));
  const all = [...answered.map((a) => a.question), ...open].sort((a, b) => a.askedAt.localeCompare(b.askedAt));
  if (all.length === 0) return null;
  return (
    <div>
      {all.map((question) => {
        const given = answered.find((a) => a.question.id === question.id);
        if (given) return <AnsweredNote key={question.id} answered={given} focus={last === question.id} run={run} onOpenStep={onOpenStep} />;
        return (
          <QuestionPanel
            key={question.id}
            run={run}
            question={question}
            primary={question.id === open[0]?.id}
            arrived={!known.has(question.id)}
            onOpenStep={onOpenStep}
            onAnswered={(a) => {
              setAnswered((list) => [...list, a]);
              setLast(a.question.id);
              if (a.goesOn) onPassed?.(a.question);
            }}
          />
        );
      })}
    </div>
  );
}
