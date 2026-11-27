// `sous join`: the person steps into the session of a step. joinTarget finds the session: the last
// call of the step that opened one, by its name in the log, its label, or the label of its
// session() handle. takeSession makes the session the person's. With a worker, it asks the worker,
// which stops a turn that runs in the session once its program has the prompt, closes a program
// the step kept open, and hands the hold over. Every other step goes on. With no worker it takes
// the hold itself. leaveSession lets go, and answers the step's open question, if it asked one, so
// the step goes on with "Continue the task." The cli opens the program between the two.

import { recordAction, type Who } from "./actions.js";
import type { HomePaths } from "./home.js";
import { listQuestions, writeAnswer, type Question } from "./inbox.js";
import { loadRecord, processAlive, readActivity, requestJoin, scopePrefix } from "./records.js";
import { Refusal } from "./refusal.js";
import { runDetail } from "./run.js";
import { readHolder, releaseHold, takeHold, type Holder } from "./session-hold.js";
import { isAgentCall, stepCalls } from "./step-view.js";
import { holdFile } from "./store.js";
import type { AgentSessionRecord } from "../workflow-result.js";

/** The session a person steps into, and what the program needs to open it as the step did. */
export interface JoinTarget {
  runId: string;
  /** The step's name in the log. */
  step: string;
  label: string;
  /** The run or nested run the step runs in. */
  scope: string;
  /** The call of the step whose session it is, counted from 1 as sous step --call counts. */
  call: number;
  /** That call's index in the run, as its activity names it. */
  callIndex?: number;
  session: AgentSessionRecord;
  /** The model the step ran on, such as claude/haiku. */
  model?: string;
  /** Whether a turn of the step runs now. */
  running: boolean;
  /** The step and call as sous step finds them. A handle's label names its session, not a step. */
  shown: { step: string; call: number };
}

/** The value a step's question gets when the person leaves its session. */
const JOINED_ANSWER = "joined";

/**
 * The session of a step, by the label of its session() handle after its nested run's name, by
 * its name in the log or its label as sous step finds it, or by a handle's bare label. The step's last call with a session gives it, or the `call`th
 * call. Refusals: no_such_step for a name the run never had, and step_has_no_session for a code
 * step or a step whose program has not named its session yet.
 */
export function joinTarget(paths: HomePaths, runId: string, step: string, options: { call?: number } = {}): JoinTarget {
  const detail = runDetail(paths, runId);
  const id = detail.record.runId;
  const show = `sous show ${id} --json`;
  const scopeOf = (agent: { scope?: unknown }) => (typeof agent.scope === "string" ? agent.scope : id);
  const prefixOf = (agent: { scope?: unknown }) => scopePrefix(id, scopeOf(agent), detail.record.nested);
  // A handle's turns may each have a label of their own. Its label still names its session, after
  // its nested run's name as sous log writes it. A bare label finds the root run's handle first.
  const handles = (named: (agent: (typeof detail.steps)[number]) => boolean) => detail.steps.filter((row) => row.session?.handle !== undefined && named(row));
  const byName = handles((row) => `${prefixOf(row)}${row.session!.handle}` === step);
  // A handle's own name, such as a join question gives, comes before a step of that label, which
  // sous step may find in a nested run.
  const found = byName.length ? undefined : stepCalls(detail, step);
  const bare = handles((row) => row.session!.handle === step);
  const bareScope = bare.some((row) => scopeOf(row) === id) ? id : bare.map(scopeOf)[0];
  const rows = byName.length ? byName : bare.filter((row) => scopeOf(row) === bareScope);
  const calls = found?.calls ?? rows.map((agent) => ({ agent, scope: scopeOf(agent) }));
  if (!calls.length) throw new Refusal("no_such_step", `run ${id} has no step "${step}".`, "Name one of the run's agent steps, by its label or its name in sous log.", show);
  const numbered = calls.map((call, i) => ({ ...call, call: i + 1 }));
  if (options.call !== undefined && !numbered[options.call - 1]) {
    throw new Refusal("no_such_step", `step "${step}" of run ${id} made ${calls.length} calls, so it has no call ${options.call}.`, `Give --call from 1 to ${calls.length}.`, show);
  }
  const chosen = options.call === undefined ? numbered.filter(({ agent }) => agent.session).at(-1) : numbered[options.call - 1]!;
  const name = found?.name ?? step;
  if (!chosen?.agent.session) {
    const code = !numbered.some(({ agent }) => isAgentCall(agent));
    const message = code ? `"${name}" is a code step, so it has no session to step into.` : `"${name}" has no session yet. Its program has not opened one.`;
    throw new Refusal("step_has_no_session", message, code ? "Name an agent step." : "Wait until the step runs, then join it.", show);
  }
  const { agent, scope, call } = chosen;
  const logName = `${prefixOf(agent)}${agent.label}`;
  const running = detail.running.includes(found ? name : logName) && call === numbered.length;
  const shownCall = found ? call : (stepCalls(detail, logName)?.calls.findIndex((row) => row.agent === agent) ?? -1) + 1;
  return {
    runId: id,
    step: name,
    label: agent.label,
    scope,
    call,
    ...(agent.callIndex === undefined ? {} : { callIndex: agent.callIndex }),
    session: agent.session!,
    ...(agent.model ? { model: agent.model } : {}),
    running,
    shown: found ? { step: name, call } : { step: logName, call: shownCall || call },
  };
}

/** The open question of the step that waits for the person to step in, if it asked one. */
export function joinQuestion(paths: HomePaths, target: JoinTarget): Question | undefined {
  const asker = target.session.handle ?? target.label;
  return listQuestions(paths, target.runId).find((question) => question.answeredBy === "join" && question.scope === target.scope && question.step === asker);
}

/** The tools through which an agent asks the person in its program. */
const ASK_TOOLS = new Set(["AskUserQuestion", "request_user_input"]);

/**
 * What the agent asked through its program's own question tool in the call `target` names, as the
 * run's activity saved it. Undefined when the call's last turn asked nothing that way, as when it
 * asked through its status.
 */
export function askedWords(paths: HomePaths, target: JoinTarget): string | undefined {
  const last = readActivity(paths, target.runId)
    .filter((line) => line.scope === target.scope && (target.callIndex === undefined ? line.label === target.label : line.callIndex === target.callIndex))
    .filter((line) => line.kind === "prompt" || (line.kind === "tool" && line.tool !== undefined && ASK_TOOLS.has(line.tool)))
    .at(-1);
  return last?.kind === "tool" ? last.text : undefined;
}

export interface TakeOptions {
  /** The process that holds the session for the person: the `sous join` itself. */
  pid?: number;
  /** How long to wait between two looks at the hold, in ms. */
  pollMs?: number;
  signal?: AbortSignal;
  /** After a stop, the wait for the worker to hand the session over and get it back ends here too,
   *  as on a second Ctrl-C. The worker may then hand the session to this process, which holds it
   *  until it ends. */
  giveUp?: AbortSignal;
  /** Called once when the session's turn has to hand it over first, and again for a step of
   *  another process that holds it. */
  onWait?: (holder: Holder | undefined) => void;
}

/**
 * Make the session the person's. It returns once the hold names `pid` as the person's. A person
 * who stepped in already keeps the session: session_joined. A stop through the signal throws
 * "stopped waiting" once a worker that has the request handed the session over and got it back.
 */
export async function takeSession(paths: HomePaths, target: JoinTarget, who: Who, options: TakeOptions = {}): Promise<void> {
  const me = options.pid ?? process.pid;
  const file = holdFile(paths, target.runId, target.session.sessionId);
  const pollMs = options.pollMs ?? 100;
  const joined = (holder: Holder | undefined) => holder?.by === "join" && holder.pid !== me;
  const refuse = (holder: Holder) =>
    new Refusal("session_joined", `someone stepped into the session of "${target.step}" already, from process ${holder.pid}.`, "Wait until they leave the session, then join it.", null);
  const first = readHolder(file);
  if (first && joined(first)) throw refuse(first);
  const ours = () => {
    const holder = readHolder(file);
    return holder?.pid === me && holder.by === "join";
  };
  const record = loadRecord(paths, target.runId);
  let told = false;
  let toldPid: number | undefined;
  const wait = async (holder: Holder | undefined) => {
    if (!told || holder?.pid !== toldPid) options.onWait?.(holder);
    told = true;
    toldPid = holder?.pid;
    await pause(pollMs, options.signal);
  };
  if (record && processAlive(record.pid)) {
    requestJoin(paths, target.runId, { sessionId: target.session.sessionId, pid: me });
    process.kill(record.pid!, "SIGUSR2");
    try {
      while (!ours() && processAlive(record.pid)) {
        const holder = readHolder(file);
        if (joined(holder)) throw refuse(holder!);
        await wait(holder);
      }
    } catch (error) {
      if (!options.signal?.aborted) throw error;
      // The worker has the request, and hands the session over once its turn lets go of it. A
      // process that goes on, such as sous wait, would then hold it for no one, so it gives the
      // session back at once and the step goes on.
      while (!ours() && processAlive(record.pid) && !options.giveUp?.aborted) await pause(pollMs, options.giveUp).catch(() => undefined);
      releaseHold(file, me);
      throw error;
    }
  }
  // No worker runs, or it ended before it handed the session over.
  while (!ours()) {
    const holder = takeHold(file, { pid: me, by: "join", at: new Date().toISOString(), label: target.label });
    if (!holder) break;
    if (joined(holder)) throw refuse(holder);
    await wait(holder);
  }
  recordAction(paths, { act: "join", ...who, runId: target.runId, step: target.step });
}

/**
 * The person left the session. It lets go of the hold the person's `pid` has, and answers the
 * step's open question, so the step goes on. With `answer` false, as when the program never
 * opened, the question stays open. Returns the question it answered.
 */
export function leaveSession(paths: HomePaths, target: JoinTarget, who: Who, options: { pid?: number; answer?: false } = {}): Question | undefined {
  releaseHold(holdFile(paths, target.runId, target.session.sessionId), options.pid ?? process.pid);
  const question = options.answer === false ? undefined : joinQuestion(paths, target);
  if (question) writeAnswer(paths, question, JOINED_ANSWER, who);
  recordAction(paths, { act: "leave", ...who, runId: target.runId, step: target.step, ...(question ? { question: question.id } : {}) });
  return question;
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("stopped waiting"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(new Error("stopped waiting"));
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
}
