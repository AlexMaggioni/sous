// One run, in its own background process. `sous run` and `sous resume` start it detached, and it
// keeps running when the terminal closes. It holds the run's lease, asks questions through the
// inbox, and answers `sous pause` (SIGUSR1), `sous stop --step`, `sous tell` and `sous join` (SIGUSR2)
// and `sous stop` (SIGTERM).

import { readFileSync, existsSync } from "node:fs";
import type { WorkflowRunResult } from "../workflow-result.js";
import type { DryRunCheck } from "../code-steps.js";
import { limitNotice, runAccounts } from "../accounts.js";
import { envFor, lookupAgents, lookupMcpServers, lookupSettings } from "../agents.js";
import { projectWorkflows } from "../workflows/dir.js";
import { shownPrompt, type CheckpointCallContext } from "../checkpoint-call.js";
import { WorkflowManager, type PersistedRunStopResult } from "../workflow-manager.js";
import { closedLine, closeRunWorktrees, runPlaces } from "../places/places.js";
import { configName, ensureHome, homePaths, loadConfig, loadSecrets, type HomePaths } from "./home.js";
import { ask, hint, questionId, removeRunQuestions, standIn, type Question } from "./inbox.js";
import { notify } from "./notify.js";
import { approvedLookup } from "./approval-check.js";
import { workflowHash } from "./approvals.js";
import { authorAnsweredBy } from "./consent.js";
import { Refusal } from "./refusal.js";
import { activityWriter, endWorker, loadRecord, loadSnapshot, placeNotes, processAlive, requestJoin, saveSnapshot, scopePrefix, takeJoins, takeNote, takePause, takeStepStops, takeTells, TELL_RECEIPTS, updateRecord, type NoteRequest, type RunRecord, type TellOutcome } from "./records.js";
import { sessionHolds } from "./session-hold.js";
import { goLimits } from "./limits.js";
import { judge } from "./rule.js";
import { agentSlots, managerStore } from "./store.js";
import { createSteps, type InnerRunner, type StepsNote } from "../steps/steps.js";
import { SteeringBoard } from "../steps/steering.js";
import type { ActivityEntry, ActivityStep, OnActivity } from "../steps/activity.js";
import { programLookup } from "../programs.js";
import { DRY_RUN_MAX_CALLS } from "../config.js";

export interface WorkerOptions {
  paths?: HomePaths;
  /** A runner that takes the place of the programs, for tests and the dry run. */
  inner?: InnerRunner;
  /** How often to look for an answer, in ms. */
  pollMs?: number;
  /** Where progress lines go. Default stdout. */
  log?: (line: string) => void;
  /** Set by the process wrapper so signals pause and stop the run. */
  handleSignals?: boolean;
  /** A dry run (`sous check --dry-run`): each question gets a stand-in answer at once, agents take
   *  no slot, nothing notifies, and a check command runs once and the step goes on as if it passed. */
  dryRun?: boolean;
  /** In a dry run, each check command that ran, with its exit code. */
  onDryRunCheck?: (check: DryRunCheck) => void;
}

/** A dry run notes each check command's exit code, and its step goes on as if the check passed. */
function dryRunCheck(log: (line: string) => void, options: WorkerOptions) {
  return (check: DryRunCheck) => {
    const after = check.code === 0 ? "" : ", and the dry run goes on as if it passed";
    log(`${stamp()} check      ${check.step}: \`${oneLine(check.command, 200)}\` ended with exit code ${check.code}${after}`);
    options.onDryRunCheck?.(check);
  };
}

/** Takes the steer signal and the stop signals for this go, and returns what lets them go. */
function listenForSignals(onSteer: () => void, onStop: () => void): () => void {
  steerHandlers.add(onSteer);
  process.on("SIGTERM", onStop);
  process.on("SIGINT", onStop);
  return () => {
    steerHandlers.delete(onSteer);
    process.off("SIGTERM", onStop);
    process.off("SIGINT", onStop);
  };
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

/** Every saved workflow the project sees now, by name, as script text. */
export function currentWorkflows(paths: HomePaths, projectDir: string): Record<string, string> {
  const dirs = projectWorkflows(paths, projectDir);
  const out: Record<string, string> = {};
  for (const entry of dirs.list()) {
    const script = dirs.resolve(entry.name);
    if (script !== undefined) out[entry.name] = script;
  }
  return out;
}

/**
 * Send the tells `sous tell` wrote through the steering board, before the step stops of the same
 * signal. Each call gets one receipt in its activity, which the cli waits for. A call with no turn
 * open gets no_turn, and the cli tells from the run's steps whether the call still runs. A call an
 * older state saved with no call index gets the first open call of its label not told yet.
 */
/** `sous join` writes the session it wants, with its own pid, then sends SIGUSR2. The steps module
 *  hands each session over once its turn lets go of it, and every other step goes on. */
function handJoins(paths: HomePaths, runId: string, runner: Pick<ReturnType<typeof createSteps>, "join">, log: (line: string) => void): void {
  for (const { sessionId, pid } of takeJoins(paths, runId)) {
    log(`${stamp()} joining    the person steps into session ${sessionId}`);
    runner.join(runId, sessionId, pid).catch((error: unknown) => log(`${stamp()} join failed: ${oneLine(String(error))}`));
  }
}

function sendTells(paths: HomePaths, runId: string, steering: SteeringBoard, onActivity: OnActivity, log: (line: string) => void): void {
  for (const { id, step, text, calls } of takeTells(paths, runId)) {
    const taken = new Set<string>();
    for (const call of calls) {
      const callIndex = call.callIndex ?? steering.openOf(call.label, call.scope).find((open) => !taken.has(`${call.scope}#${open.callIndex}`))?.callIndex;
      if (callIndex !== undefined) taken.add(`${call.scope}#${callIndex}`);
      const told = callIndex === undefined ? Promise.resolve([]) : steering.tell({ label: call.label, scope: call.scope, callIndex }, text, id);
      // A call with no index and no open call to take has a receipt under its label alone.
      const receipt = onActivity as (step: Omit<ActivityStep, "callIndex"> & { callIndex?: number }, entry: ActivityEntry) => void;
      void told.then((outcomes) => {
        const outcome: TellOutcome = outcomes[0]?.outcome ?? "no_turn";
        receipt({ scope: call.scope, label: call.label, ...(callIndex === undefined ? {} : { callIndex }) }, { kind: "tell", id, text: TELL_RECEIPTS[outcome] });
        log(`${stamp()} tell       ${step}: ${TELL_RECEIPTS[outcome]}`);
      });
    }
  }
}

/** What SIGUSR2 does in this process: each run whose steps run takes its tells and step stops. */
const steerHandlers = new Set<() => void>();
const onSteerSignal = () => {
  for (const handler of steerHandlers) handler();
};
let steerHolders = 0;

/** Keep the SIGUSR2 handler in place until the call it returns, so the signal never ends the process
 *  before a run's steps start or after they end. Holds nest, and the last release removes it. */
function holdSteerSignal(): () => void {
  if (steerHolders++ === 0) process.on("SIGUSR2", onSteerSignal);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    if (--steerHolders === 0) process.off("SIGUSR2", onSteerSignal);
  };
}

/** Pause the run on each `sous pause` until the call it returns, also one asked before. `sous pause`
 *  leaves a file, and sends SIGUSR1 once the record says the worker listens. Each run takes only its
 *  own file, so runs that share a process, as in tests, pause one at a time. */
function answerPause(paths: HomePaths, runId: string, manager: { pause(runId: string): boolean }, log: (line: string) => void): () => void {
  let ended = false;
  const onSignal = () => {
    if (!takePause(paths, runId)) return;
    log(`${stamp()} pausing`);
    if (manager.pause(runId)) return;
    // A pause that came before the manager runs the run waits for it, until the run ends.
    const retry = setInterval(() => {
      if (ended || manager.pause(runId)) clearInterval(retry);
    }, 50);
  };
  process.on("SIGUSR1", onSignal);
  updateRecord(paths, runId, { listening: process.pid });
  onSignal();
  return () => {
    ended = true;
    // The record stops naming the worker as listening before the handler goes, so no SIGUSR1
    // comes without one. A pause asked as the worker ends is for this worker, not the next.
    updateRecord(paths, runId, { listening: undefined });
    process.off("SIGUSR1", onSignal);
    takePause(paths, runId);
  };
}

/** The engine's manager for a run's project. Only this file builds one. A nested workflow() or
 *  choose() finds its workflow by `lookup`, the project's live ones by default, and a run an agent
 *  started finds no people workflow there. */
function managerFor(paths: HomePaths, record: RunRecord, lookup?: (name: string) => string | undefined) {
  const dirs = projectWorkflows(paths, record.projectDir);
  const guard = approvedLookup(paths, record, lookup ?? ((name) => dirs.resolve(name)));
  return new WorkflowManager({
    ...managerStore(paths),
    defaultAgentRetries: loadConfig(paths).retries,
    loadSavedWorkflow: guard.lookup,
    sous: {
      // What an agent may pick with choose({ any: true }). Workflows for people only stay out, and
      // so do those the guard refuses the run.
      listSavedWorkflows: () =>
        dirs
          .list()
          .filter((entry) => entry.extras && entry.extras.startedBy !== "people" && guard.offers(entry))
          .map((entry) => ({ name: entry.name, ...(entry.meta?.description ? { description: entry.meta.description } : {}) })),
      // A run tree's nested runs and step worktrees go under this home's worktrees folder, and its
      // root run's record names them.
      places: (rootRunId) => runPlaces(paths, placeNotes(paths, rootRunId)),
    },
  });
}

/** Stop a run that no worker runs: a paused run, or one whose worker died. The manager saves it
 *  as stopped under the run's lease and changes no other run's files. */
export function stopColdRun(paths: HomePaths, record: RunRecord): PersistedRunStopResult {
  return managerFor(paths, record).stopPersistedRun(record.runId);
}

/** Run or resume one run in this process. Resolves with the engine's result. */
export async function runWorker(runId: string, mode: "start" | "resume", options: WorkerOptions): Promise<WorkflowRunResult | undefined> {
  const paths = ensureHome(options.paths ?? homePaths());
  const record = loadRecord(paths, runId);
  if (!record) throw new Error(`no run ${runId}`);
  // A resume's note goes to this go only, so it is taken before any check that ends the go.
  const note = mode === "resume" ? takeNote(paths, runId) : undefined;
  const script = checkedText(paths, record, mode);
  // The steps run on the run's recorded accounts, also when the service resumes it with its own
  // environment. A dry run talks to no agent.
  const accounts = options.dryRun ? {} : runAccounts(paths, record.accounts);
  return runOnAccounts(paths, record, mode, options, accounts, script, note);
}

/** A resume's note for the steps of this go. The log says whom it is for, and at the end of the go
 *  that it reached no step when no agent call took it, since the note is gone after this go. */
function noteForGo(note: NoteRequest | undefined, log: (line: string) => void): { steps?: StepsNote; end(): void } {
  if (!note) return { end: () => {} };
  const noteFor = note.step ? note.step.name : "the first agent call";
  log(`${stamp()} note       for ${noteFor}`);
  let taken = false;
  return {
    steps: { text: note.text, ...(note.step ? { step: note.step.label, scopes: note.step.scopes } : {}), taken: () => (taken = true) },
    end: () => {
      if (!taken) log(`${stamp()} note       for ${noteFor} reached no step in this go`);
    },
  };
}

/**
 * The workflow's text a start runs, or a resume after `sous resume --latest`, read once. It is
 * the text sous checked: the one whose hash it wrote in the record, or at resume --latest. A
 * changed or missing file is refused, and the record keeps why, so `sous show` gives it. Another
 * resume runs the text the run started with, and gets undefined.
 */
function checkedText(paths: HomePaths, record: RunRecord, mode: "start" | "resume"): string | undefined {
  if (mode === "resume" && record.resumeLatest !== true) return undefined;
  const text = existsSync(record.file) ? readFileSync(record.file, "utf8") : undefined;
  const checked = mode === "start" ? record.workflowHash : record.latestHash;
  // A record from before the hash resumes with the text it started with.
  if (mode === "resume" && checked === undefined) return undefined;
  if (text !== undefined && (checked === undefined || workflowHash(text) === checked)) return text;
  const what = text === undefined ? "is gone" : "changed after sous checked it";
  const refused =
    mode === "start"
      ? `${record.file} ${what}, so run ${record.runId} did not start. Start it again, which checks the text again.`
      : `${record.file} ${what} at sous resume --latest, so run ${record.runId} did not resume. Resume it again, which checks the text again.`;
  updateRecord(paths, record.runId, { refused, ...(mode === "resume" ? { resumeLatest: undefined, latestHash: undefined } : {}) });
  const call = mode === "start" ? `sous rerun ${record.runId} --json` : `sous resume ${record.runId} --latest --json`;
  throw new Refusal("not_approved", refused, "Start or resume the run again. sous checks the text as it is now.", call);
}

/** Run one go of the run on its accounts, with `note`, the note `sous resume --note` left for it. */
/** The question a checkpoint() call asks. An agent's question in its turn is the person's to
 *  answer in its session, where they read it. The journal keeps the agent's message. The log, the
 *  notice and the page name the step. */
function questionOf(runId: string, workflow: string, prompt: string, checkpoint: { kind?: "confirm" | "input" | "select"; choices?: string[]; schema?: Record<string, unknown> }, context: CheckpointCallContext | undefined): Question {
  const scope = context?.scope ?? runId;
  const callIndex = context?.callIndex ?? 0;
  const purpose = context?.purpose;
  return {
    id: questionId(scope, callIndex),
    runId,
    scope,
    callIndex,
    hash: context?.hash ?? "",
    workflow,
    prompt: shownPrompt(prompt, purpose),
    kind: checkpoint.kind ?? "confirm",
    ...(checkpoint.choices ? { choices: [...checkpoint.choices] } : {}),
    breakpoint: purpose?.breakpoint === true,
    ...(purpose?.title ? { title: purpose.title } : {}),
    ...(purpose?.show ? { show: purpose.show } : {}),
    answeredBy: authorAnsweredBy({ answeredBy: purpose?.answeredBy, breakpoint: purpose?.breakpoint }),
    ...(purpose?.step ? { step: purpose.step } : {}),
    ...(checkpoint.schema ? { schema: checkpoint.schema } : {}),
    askedAt: new Date().toISOString(),
  };
}

async function runOnAccounts(
  paths: HomePaths,
  record: RunRecord,
  mode: "start" | "resume",
  options: WorkerOptions,
  accounts: ReturnType<typeof runAccounts>,
  /** The checked text a start or a resume --latest runs. */
  script: string | undefined,
  note: NoteRequest | undefined,
): Promise<WorkflowRunResult | undefined> {
  const runId = record.runId;
  const config = loadConfig(paths);
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  updateRecord(paths, runId, { pid: process.pid, pauseFile: true, limit: undefined, refused: undefined });
  // A step stop the last worker never took names a step of that worker, not this one. A join names
  // a session, which outlives the worker, so one whose `sous join` still waits stays for this one.
  takeStepStops(paths, runId);
  for (const join of takeJoins(paths, runId)) if (processAlive(join.pid)) requestJoin(paths, runId, join);
  const goNote = noteForGo(note, log);

  // The environment with the run's accounts on it, for code steps and the agent lookup.
  const base = envFor("codex", accounts.codex, envFor("claude", accounts.claude, process.env));
  const settings = lookupSettings(paths, record.projectDir, config, base);
  const agents = lookupAgents(settings);
  const secrets = loadSecrets(paths);
  const slots = agentSlots(paths, () => loadConfig(paths).maxAgents, record.priority);
  const inner = options.inner;
  // It reads the file at its first write, once the run manager holds the run's lease.
  const onActivity = activityWriter(paths, runId, Object.values(secrets));
  const steering = new SteeringBoard();
  // The time limit and the budget of this go.
  const limits = goLimits(record, log);
  const runner = createSteps({
    cwd: record.cwd,
    ...(inner ? { inner } : {}),
    ...(options.dryRun ? {} : { slots }),
    agents,
    mcp: lookupMcpServers(settings, { ...base, ...secrets }),
    accounts,
    // A runner from a test or the dry run brings its own programs.
    ...(inner ? {} : { programs: programLookup(config, configName(paths)) }),
    onSlot: ({ label, state }) => {
      if (state === "waiting" && slots.held().length >= Math.max(1, loadConfig(paths).maxAgents)) {
        log(`${stamp()} queued     ${label ?? "agent"} waits for a free agent slot`);
      }
    },
    onProgram: ({ program, name, path, version }) => {
      log(`${stamp()} program    ${name} ${version ?? "(version unknown)"} at ${path}`);
      const programs = { ...loadRecord(paths, runId)?.programs, [program]: { path, ...(version ? { version } : {}) } };
      updateRecord(paths, runId, { programs });
    },
    onLimit: ({ program }) => {
      const account = loadRecord(paths, runId)?.accounts?.[program]?.name ?? "default";
      updateRecord(paths, runId, { limit: { program, account, at: new Date().toISOString() } });
    },
    onNotes: ({ label, notes }) => {
      for (const note of notes) log(`${stamp()} note       ${label ?? "agent"}: ${oneLine(note, 400)}`);
    },
    onActivity,
    steering,
    gate: limits.gate,
    onUsage: limits.onUsage,
    ...(goNote.steps ? { note: goNote.steps } : {}),
    // A dry run's sessions are stand-ins that no person can step into.
    ...(options.dryRun ? {} : { holds: sessionHolds(paths) }),
    onWait: ({ label }) => log(`${stamp()} waiting    ${label ?? "agent"} waits while the person works in its session`),
  });
  // A run keeps the workflows as they were when it started. A resume takes the edited ones only
  // after `sous resume --latest`.
  const takeLatest = mode === "resume" && record.resumeLatest === true;
  if (mode === "start" || takeLatest) saveSnapshot(paths, runId, currentWorkflows(paths, record.projectDir));
  if (takeLatest) updateRecord(paths, runId, { resumeLatest: undefined, latestHash: undefined });
  const snapshot = loadSnapshot(paths, runId);
  const live = projectWorkflows(paths, record.projectDir);
  const manager = managerFor(paths, record, (name) => snapshot[name] ?? live.resolve(name));

  const waits = new AbortController();
  const pollMs = options.pollMs ?? 500;
  const confirm = (prompt: string, checkpoint: { kind?: "confirm" | "input" | "select"; choices?: string[]; schema?: Record<string, unknown> }, context?: CheckpointCallContext) => {
    const made = questionOf(runId, record.workflow, prompt, checkpoint, context);
    const joins = made.answeredBy === "join";
    // `sous join` finds a nested run's step after the nested run's name, as sous log writes it.
    const question = joins && made.step && made.scope !== runId ? { ...made, join: `${from(made.scope)}${made.step}` } : made;
    const { id, scope } = question;
    // An answer that did not fit the question's schema: the run asks again.
    if (context?.refused !== undefined) log(`${stamp()} refused    ${id}: ${oneLine(context.refused, 400)}`);
    if (options.dryRun) {
      // A stand-in that does not fit would be asked for again and again.
      if (context?.refused !== undefined) return Promise.reject(new Error(`a dry run has no answer that fits the schema of ${id}`));
      const value = standIn(question);
      log(`${stamp()} question   ${from(scope)}${oneLine(question.prompt, 200)}\n           answered   ${JSON.stringify(value)} (dry run)`);
      return Promise.resolve(value);
    }
    const asked = () => {
      context?.asked?.();
      log(`${stamp()} question   ${id}: ${oneLine(question.prompt, 400)}\n           ${joins ? "step in with" : "answer with"}: ${hint(question, "log")}`);
      if (joins) notify(`${question.step ?? "an agent"} needs you`, `Step in with: ${hint(question)}`, config.notify);
      else notify(`${record.workflow} asks`, oneLine(prompt, 200), config.notify);
    };
    return ask(paths, question, { signal: waits.signal, pollMs, asked }).then((value) => {
      log(`${stamp()} answered   ${id}: ${oneLine(JSON.stringify(value))}`);
      return value;
    });
  };

  // A nested run's lines start with its label, so parallel nested runs read apart in the log.
  const prefixes = new Map<string, string>();
  const from = (scope: string | undefined) => {
    if (!scope || scope === runId) return "";
    const known = prefixes.get(scope);
    if (known !== undefined) return known;
    const prefix = scopePrefix(runId, scope, loadRecord(paths, runId)?.nested);
    prefixes.set(scope, prefix);
    return prefix;
  };
  manager.on("agentStart", (event) => {
    log(`${stamp()} start      ${from(event.scope)}${event.label}${event.model ? ` (${event.model})` : ""}`);
  });
  manager.on("agentEnd", (event) => {
    const tokens = event.tokens ? `, ${event.tokens} tokens` : "";
    if (event.error) log(`${stamp()} failed     ${from(event.scope)}${event.label}: ${oneLine(event.error)}${tokens}`);
    else log(`${stamp()} done       ${from(event.scope)}${event.label}${tokens}`);
  });
  manager.on("log", (event) => log(`${stamp()} log        ${from(event.scope)}${oneLine(event.message, 400)}`));
  manager.on("phase", (event) => log(`${stamp()} phase      ${from(event.scope)}${event.title}`));

  let stopping = false;
  // `sous stop --step` writes its request, with each call to stop, then sends SIGUSR2.
  const onStopSteps = () => {
    for (const { step, calls } of takeStepStops(paths, runId)) {
      let stopped = 0;
      for (const call of calls) stopped += manager.cancelAgentSteps(runId, call);
      log(`${stamp()} ${stopped ? `stopping   ${step}` : `no step    ${step} runs; nothing stopped`}`);
    }
  };
  // The tells go first. sendTells hands each message to its call's seam at once, so a call told and
  // stopped by the same signal is handed the message before the stop aborts it.
  const onSteer = () => {
    sendTells(paths, runId, steering, onActivity, log);
    onStopSteps();
    handJoins(paths, runId, runner, log);
  };
  const onStop = () => {
    stopping = true;
    log(`${stamp()} stopping`);
    manager.stop(runId);
  };
  const releaseSteer = options.handleSignals ? holdSteerSignal() : undefined;
  const releasePause = options.handleSignals ? answerPause(paths, runId, manager, log) : undefined;
  const releaseSignals = options.handleSignals ? listenForSignals(onSteer, onStop) : undefined;
  // A tell sent before the steps start gets its receipt now. No call is open yet, so it is no_turn,
  // and the cli tells from the run's steps whether its call runs.
  sendTells(paths, runId, steering, onActivity, log);
  // A join asked before the worker listened, whose signal came too early, gets its session now.
  if (releaseSignals) handJoins(paths, runId, runner, log);

  const exec = {
    agent: runner,
    cwd: record.cwd,
    confirm: confirm as never,
    // Code steps also get the project folder, since a run may work elsewhere (a worktree, a scratch folder).
    codeEnv: { env: { ...secrets, SOUS_PROJECT: record.projectDir }, base, onActivity, ...(options.dryRun ? { onDryRunCheck: dryRunCheck(log, options) } : {}) },
    ...(record.concurrency ? { concurrency: record.concurrency } : {}),
    // A dry run keeps a cap on its calls, since it starts no program and a loop would never end.
    ...(options.dryRun ? { maxAgents: DRY_RUN_MAX_CALLS } : {}),
    ...(record.overrides ? { stepOverrides: record.overrides } : {}),
    ...(record.defaultModel ?? config.defaultModel ? { defaultModel: record.defaultModel ?? config.defaultModel } : {}),
  };

  limits.watch(manager);

  let result: WorkflowRunResult | undefined;
  // Why a resumed run stopped again, so the log can say it. A run paused for a lost login runs
  // its step again, and while the login is still gone the step fails and the run pauses again.
  let why: string | undefined;
  try {
    if (mode === "start") {
      log(`${stamp()} run        ${record.workflow} in ${record.cwd}`);
      result = await manager.runSync(script!, record.args, {
        ...exec,
        runId,
        ...(record.reuseFrom ? { resumeFromRunId: record.reuseFrom } : {}),
      });
    } else {
      log(`${stamp()} resume     ${record.workflow}`);
      // The engine keeps the place and the model from the start, so a resume passes neither.
      const { cwd: _cwd, defaultModel: _model, ...controls } = exec as typeof exec & { defaultModel?: string };
      const resumed = await manager.resumeInBackground(runId, { ...controls, ...(script ? { script } : {}) });
      if (!resumed.accepted) {
        const state = manager.getPersistence().load(runId);
        throw new Error(`run ${runId} cannot resume (status ${state?.status ?? "unknown"}${state?.reason ? `: ${state.reason}` : ""})`);
      }
      result = await resumed.promise.catch((error: unknown) => {
        why = error instanceof Error ? error.message : String(error);
        return undefined;
      });
    }
  } finally {
    limits.end();
    waits.abort();
    releaseSignals?.();
    releaseSteer?.();
    releasePause?.();
    await runner.dispose().catch(() => {});
  }

  goNote.end();
  const state = manager.getPersistence().load(runId);
  const status = result?.status ?? state?.status ?? "unknown";
  // The worker ends, so it judges its run as gone. The run's result wins over the saved status.
  const { pause } = judge({ state: status === "unknown" ? undefined : { updatedAt: "", ...state, status }, alive: false, openQuestions: 0 });
  if (!pause || stopping) removeRunQuestions(paths, runId);
  endWorker(paths, runId);
  const reason = state?.pauseReason ? ` (${state.pauseReason}${state.resetHint ? `, ${state.resetHint}` : ""})` : "";
  // A paused resume rejects with its error. A paused start resolves, and the state saves the
  // error's message as its reason when the message says more than the pause reason does.
  const pausedWhy = why ?? (state?.reason !== state?.pauseReason ? state?.reason : undefined);
  const error = status === "paused" ? pausedWhy : status === "failed" ? (result?.reason ?? state?.reason) : undefined;
  log(`${stamp()} ${status.padEnd(10)} ${record.workflow}${reason}${error ? `: ${oneLine(String(error), 400)}` : ""}`);
  const atLimit = pause?.reason === "usage_limit" && !stopping;
  const limitText = atLimit ? limitNotice(paths, loadRecord(paths, runId) ?? record, pause?.resetAt) : undefined;
  if (limitText) log(`${stamp()} limit      ${limitText}`);
  // The run ended, so the scope of each worktree it still has ends. A paused or failed run keeps
  // its folders for its resume.
  if (status === "completed" || status === "aborted") {
    for (const line of closeRunWorktrees(loadRecord(paths, runId) ?? record).map((close) => closedLine(close.tree, close))) log(`${stamp()} ${line}`);
  }
  // A scheduled run speaks up only when it needs the user or fails.
  const quiet = options.dryRun || (record.origin === "schedule" && (status === "completed" || status === "aborted"));
  if (!quiet) {
    notify(
      `${record.workflow} ${status}`,
      limitText ?? (status === "paused" ? `paused${reason}. sous resume ${runId}` : status === "failed" ? oneLine(String(error ?? "failed"), 200) : `run ${runId}`),
      config.notify,
    );
  }
  return result;
}

/** The detached process: `sous _worker <runId> start|resume`. */
export async function workerMain(runId: string, mode: "start" | "resume"): Promise<number> {
  // The agents' shells inherit it, so `sous run` knows when an agent starts a workflow.
  process.env.SOUS_RUN_ID = runId;
  // The record names this process from its launch, so `sous tell` and `sous stop --step` may signal
  // it before the steps start or after they end. The handler stays until the pid clears.
  const release = holdSteerSignal();
  try {
    const result = await runWorker(runId, mode, { handleSignals: true });
    return result?.status === "failed" ? 1 : 0;
  } catch (error) {
    // A refusal says why in one line, and the record keeps it for sous show.
    const why = error instanceof Refusal ? error.message : ((error as Error).stack ?? String(error));
    process.stderr.write(`${stamp()} ${error instanceof Refusal ? "refused   " : "error     "} ${why}\n`);
    endWorker(homePaths(), runId);
    return 1;
  } finally {
    release();
  }
}
