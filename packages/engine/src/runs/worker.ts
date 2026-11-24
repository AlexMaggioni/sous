// One run, in its own background process. `sous run` and `sous resume` start it detached, and it
// keeps running when the terminal closes. It holds the run's lease, asks questions through the
// inbox, and answers `sous pause` (SIGUSR1), `sous stop --step` (SIGUSR2) and `sous stop` (SIGTERM).

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
import { nestedLookup } from "./consent.js";
import { activityWriter, loadRecord, loadSnapshot, placeNotes, saveSnapshot, scopePrefix, takeStepStops, updateRecord, type RunRecord } from "./records.js";
import { judge } from "./rule.js";
import { agentSlots, managerStore } from "./store.js";
import { createSteps, type InnerRunner } from "../steps/steps.js";
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

/** The engine's manager for a run's project. Only this file builds one. A nested workflow() or
 *  choose() finds its workflow by `lookup`, the project's live ones by default, and a run an agent
 *  started finds no people workflow there. */
function managerFor(paths: HomePaths, record: RunRecord, lookup?: (name: string) => string | undefined) {
  const dirs = projectWorkflows(paths, record.projectDir);
  return new WorkflowManager({
    ...managerStore(paths),
    defaultAgentRetries: loadConfig(paths).retries,
    loadSavedWorkflow: nestedLookup(record.through, lookup ?? ((name) => dirs.resolve(name))),
    sous: {
      maxNestingDepth: 5,
      // What an agent may pick with choose({ any: true }). Workflows for people only stay out.
      listSavedWorkflows: () =>
        dirs
          .list()
          .filter((entry) => entry.extras && entry.extras.startedBy !== "people")
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
  // The steps run on the run's recorded accounts, also when the service resumes it with its own
  // environment. A dry run talks to no agent.
  const accounts = options.dryRun ? {} : runAccounts(paths, record.accounts);
  return runOnAccounts(paths, record, mode, options, accounts);
}

async function runOnAccounts(
  paths: HomePaths,
  record: RunRecord,
  mode: "start" | "resume",
  options: WorkerOptions,
  accounts: ReturnType<typeof runAccounts>,
): Promise<WorkflowRunResult | undefined> {
  const runId = record.runId;
  const config = loadConfig(paths);
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  updateRecord(paths, runId, { pid: process.pid, limit: undefined });
  // A step stop the last worker never took names a step of that worker, not this one.
  takeStepStops(paths, runId);

  // The environment with the run's accounts on it, for code steps and the agent lookup.
  const base = envFor("codex", accounts.codex, envFor("claude", accounts.claude, process.env));
  const settings = lookupSettings(paths, record.projectDir, config, base);
  const agents = lookupAgents(settings);
  const secrets = loadSecrets(paths);
  const slots = agentSlots(paths, () => loadConfig(paths).maxAgents, record.priority);
  const inner = options.inner;
  // It reads the file at its first write, once the run manager holds the run's lease.
  const onActivity = activityWriter(paths, runId, Object.values(secrets));
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
  });
  // A run keeps the workflows as they were when it started. A resume takes the edited ones only
  // after `sous resume --latest`.
  const takeLatest = mode === "resume" && record.resumeLatest === true;
  if (mode === "start" || takeLatest) saveSnapshot(paths, runId, currentWorkflows(paths, record.projectDir));
  if (takeLatest) updateRecord(paths, runId, { resumeLatest: undefined });
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
      answeredBy: context?.purpose?.answeredBy === "anyone" && !context.purpose.breakpoint ? "anyone" : "people",
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
  const onStop = () => {
    stopping = true;
    log(`${stamp()} stopping`);
    manager.stop(runId);
  };
  if (options.handleSignals) {
    process.on("SIGUSR1", onPause);
    process.on("SIGUSR2", onStopSteps);
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
      result = await manager.runSync(readFileSync(record.file, "utf8"), record.args, {
        ...exec,
        runId,
        ...(record.reuseFrom ? { resumeFromRunId: record.reuseFrom } : {}),
      });
    } else {
      log(`${stamp()} resume     ${record.workflow}`);
      const script = takeLatest && existsSync(record.file) ? readFileSync(record.file, "utf8") : undefined;
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
      process.off("SIGUSR2", onStopSteps);
      process.off("SIGTERM", onStop);
      process.off("SIGINT", onStop);
    }
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
  try {
    const result = await runWorker(runId, mode, { handleSignals: true });
    return result?.status === "failed" ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${stamp()} error      ${(error as Error).stack ?? String(error)}\n`);
    const paths = homePaths();
    if (loadRecord(paths, runId)) updateRecord(paths, runId, { pid: undefined });
    return 1;
  }
}
