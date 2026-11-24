// One run, in its own background process. `sous run` and `sous resume` start it detached, and it
// keeps running when the terminal closes. It holds the run's lease, asks questions through the
// inbox, and answers `sous pause` (SIGUSR1), `sous stop --step` and `sous tell` (SIGUSR2) and `sous stop` (SIGTERM).

import { readFileSync, existsSync } from "node:fs";
import type { WorkflowRunResult } from "../workflow-result.js";
import { limitNotice, runAccounts } from "../accounts.js";
import { envFor, lookupAgents, lookupMcpServers, lookupSettings } from "../agents.js";
import { parseDurationSeconds } from "../duration.js";
import { projectWorkflows } from "../workflows/dir.js";
import type { CheckpointCallContext } from "../checkpoint-call.js";
import { WorkflowManager, type PersistedRunStopResult } from "../workflow-manager.js";
import { dropUnchangedWorktrees, runPlaces, runWorktrees } from "../places/places.js";
import { ensureHome, homePaths, loadConfig, loadSecrets, type HomePaths } from "./home.js";
import { ask, hint, questionId, removeRunQuestions, standIn, type Question } from "./inbox.js";
import { notify } from "./notify.js";
import { approvedLookup } from "./approval-check.js";
import { workflowHash } from "./approvals.js";
import { authorAnsweredBy } from "./consent.js";
import { Refusal } from "./refusal.js";
import { activityWriter, loadRecord, loadSnapshot, placeNotes, saveSnapshot, scopePrefix, takeStepStops, takeTells, TELL_RECEIPTS, updateRecord, type RunRecord, type TellOutcome } from "./records.js";
import { judge } from "./rule.js";
import { agentSlots, managerStore } from "./store.js";
import { createSteps, type InnerRunner } from "../steps/steps.js";
import { SteeringBoard } from "../steps/steering.js";
import type { ActivityEntry, ActivityStep, OnActivity } from "../steps/activity.js";
import { programLookup } from "../programs.js";

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
   *  no slot, and nothing notifies. */
  dryRun?: boolean;
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
      maxNestingDepth: 5,
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
  const script = checkedText(paths, record, mode);
  // The steps run on the run's recorded accounts, also when the service resumes it with its own
  // environment. A dry run talks to no agent.
  const accounts = options.dryRun ? {} : runAccounts(paths, record.accounts);
  return runOnAccounts(paths, record, mode, options, accounts, script);
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

async function runOnAccounts(
  paths: HomePaths,
  record: RunRecord,
  mode: "start" | "resume",
  options: WorkerOptions,
  accounts: ReturnType<typeof runAccounts>,
  /** The checked text a start or a resume --latest runs. */
  script: string | undefined,
): Promise<WorkflowRunResult | undefined> {
  const runId = record.runId;
  const config = loadConfig(paths);
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  updateRecord(paths, runId, { pid: process.pid, limit: undefined, refused: undefined });
  // A step stop the last worker never took names a step of that worker, not this one.
  takeStepStops(paths, runId);
  takeTells(paths, runId);

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
  const runner = createSteps({
    cwd: record.cwd,
    ...(inner ? { inner } : {}),
    ...(options.dryRun ? {} : { slots }),
    agents,
    mcp: lookupMcpServers(settings, { ...base, ...secrets }),
    accounts,
    // A runner from a test or the dry run brings its own programs.
    ...(inner ? {} : { programs: programLookup(config) }),
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
  const confirm = (prompt: string, checkpoint: { kind?: "confirm" | "input" | "select"; choices?: string[] }, context?: CheckpointCallContext) => {
    const scope = context?.scope ?? runId;
    const callIndex = context?.callIndex ?? 0;
    const id = questionId(scope, callIndex);
    const question: Question = {
      id,
      runId,
      scope,
      callIndex,
      hash: context?.hash ?? "",
      workflow: record.workflow,
      prompt,
      kind: checkpoint.kind ?? "confirm",
      ...(checkpoint.choices ? { choices: [...checkpoint.choices] } : {}),
      breakpoint: context?.purpose?.breakpoint === true,
      answeredBy: authorAnsweredBy({ answeredBy: context?.purpose?.answeredBy, breakpoint: context?.purpose?.breakpoint }),
      ...(context?.purpose?.step ? { step: context.purpose.step } : {}),
      askedAt: new Date().toISOString(),
    };
    if (options.dryRun) {
      const value = standIn(question);
      log(`${stamp()} question   ${from(scope)}${oneLine(prompt, 200)}\n           answered   ${JSON.stringify(value)} (dry run)`);
      return Promise.resolve(value);
    }
    const asked = () => {
      log(`${stamp()} question   ${id}: ${oneLine(prompt, 400)}\n           answer with: ${hint(question, "log")}`);
      notify(`${record.workflow} asks`, oneLine(prompt, 200), config.notify);
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
  const onPause = () => {
    log(`${stamp()} pausing`);
    manager.pause(runId);
  };
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
  };
  const onStop = () => {
    stopping = true;
    log(`${stamp()} stopping`);
    manager.stop(runId);
  };
  const releaseSteer = options.handleSignals ? holdSteerSignal() : undefined;
  if (options.handleSignals) {
    process.on("SIGUSR1", onPause);
    steerHandlers.add(onSteer);
    process.on("SIGTERM", onStop);
    process.on("SIGINT", onStop);
  }

  const exec = {
    agent: runner,
    cwd: record.cwd,
    confirm: confirm as never,
    // Code steps also get the project folder, since a run may work elsewhere (a worktree, a scratch folder).
    codeEnv: { env: { ...secrets, SOUS_PROJECT: record.projectDir }, base, onActivity },
    ...(record.concurrency ? { concurrency: record.concurrency } : {}),
    ...(record.overrides ? { stepOverrides: record.overrides } : {}),
    ...(record.defaultModel ?? config.defaultModel ? { defaultModel: record.defaultModel ?? config.defaultModel } : {}),
  };

  // The workflow's time limit: the running steps stop and the run pauses on them.
  const limit = record.timeout ? parseDurationSeconds(record.timeout) : undefined;
  const limitTimer = limit
    ? setTimeout(() => {
        log(`${stamp()} time limit ${record.timeout} reached: the running steps stop and the run pauses`);
        const message = `the workflow's time limit of ${record.timeout} was reached`;
        if (!manager.cancelAgentSteps(runId, { pauseReason: "time_limit", message })) manager.pause(runId);
      }, limit * 1000)
    : undefined;

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
    clearTimeout(limitTimer);
    waits.abort();
    if (options.handleSignals) {
      process.off("SIGUSR1", onPause);
      steerHandlers.delete(onSteer);
      process.off("SIGTERM", onStop);
      process.off("SIGINT", onStop);
    }
    releaseSteer?.();
    await runner.dispose().catch(() => {});
  }

  const state = manager.getPersistence().load(runId);
  const status = result?.status ?? state?.status ?? "unknown";
  // The worker ends, so it judges its run as gone. The run's result wins over the saved status.
  const { pause } = judge({ state: status === "unknown" ? undefined : { updatedAt: "", ...state, status }, alive: false, openQuestions: 0 });
  if (!pause || stopping) removeRunQuestions(paths, runId);
  updateRecord(paths, runId, { pid: undefined });
  const reason = state?.pauseReason ? ` (${state.pauseReason}${state.resetHint ? `, ${state.resetHint}` : ""})` : "";
  // A paused resume rejects with its error. A paused start resolves, and the state saves the
  // error's message as its reason when the message says more than the pause reason does.
  const pausedWhy = why ?? (state?.reason !== state?.pauseReason ? state?.reason : undefined);
  const error = status === "paused" ? pausedWhy : status === "failed" ? (result?.reason ?? state?.reason) : undefined;
  log(`${stamp()} ${status.padEnd(10)} ${record.workflow}${reason}${error ? `: ${oneLine(String(error), 400)}` : ""}`);
  const atLimit = pause?.reason === "usage_limit" && !stopping;
  const limitText = atLimit ? limitNotice(paths, loadRecord(paths, runId) ?? record, pause?.resetAt) : undefined;
  if (limitText) log(`${stamp()} limit      ${limitText}`);
  if (status === "completed" || status === "aborted") {
    const trees = runWorktrees(loadRecord(paths, runId) ?? record);
    for (const dir of dropUnchangedWorktrees(record.projectDir, trees)) log(`${stamp()} removed    ${dir}, which changed no file`);
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
    const paths = homePaths();
    if (loadRecord(paths, runId)) updateRecord(paths, runId, { pid: undefined });
    return 1;
  } finally {
    release();
  }
}
