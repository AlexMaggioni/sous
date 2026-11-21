// One run, in its own background process. `orc run` and `orc resume` start it detached, and it
// keeps running when the terminal closes. It holds the run's lease, asks questions through the
// inbox, and answers `orc pause` (SIGUSR1) and `orc stop` (SIGTERM).

import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { WorkflowManager, openWorkflowDir, parseWorkflowScript, type WorkflowRunResult } from "@automatalabs/workflow-engine";
import type { AgentRunner } from "@automatalabs/shared-types";
import { agentsDirOption, ensureHome, homePaths, loadConfig, loadMcpServers, loadSecrets, workflowDirs, type HomePaths } from "./home.js";
import { checkInputs, workflowExtras } from "./inputs.js";
import { questionId, readAnswer, removeQuestion, removeRunQuestions, writeQuestion, type Question } from "./inbox.js";
import { notify } from "./notify.js";
import { dropUnchangedWorktrees, isPlace, preparePlace } from "./places.js";
import { loadRecord, noteNested, updateRecord, type RunRecord } from "./records.js";
import { createOrcRunner } from "./runner.js";
import { SlotPool } from "./slots.js";

export interface WorkerOptions {
  paths?: HomePaths;
  /** The agent runner. Defaults to $ORC_AGENT_MODULE's default export, else AgentPrism's ACP runner. */
  inner?: AgentRunner;
  /** How often to look for an answer, in ms. */
  pollMs?: number;
  /** Where progress lines go. Default stdout. */
  log?: (line: string) => void;
  /** Set by the process wrapper so signals pause and stop the run. */
  handleSignals?: boolean;
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

async function loadInner(): Promise<AgentRunner | undefined> {
  const module = process.env.ORC_AGENT_MODULE;
  if (!module) return undefined;
  const loaded = (await import(pathToFileURL(module).href)) as { default?: AgentRunner };
  if (!loaded.default || typeof loaded.default.run !== "function") throw new Error(`${module} must export a default runner with run()`);
  return loaded.default;
}

export function managerFor(paths: HomePaths, projectDir: string, extra: Partial<ConstructorParameters<typeof WorkflowManager>[0]> = {}) {
  const dirs = openWorkflowDir(workflowDirs(projectDir, paths));
  return new WorkflowManager({
    // Run state is keyed to the manager's folder, so every orc manager uses the home folder.
    cwd: paths.home,
    persistenceRoot: paths.runs,
    agentsDir: agentsDirOption(projectDir, paths),
    defaultAgentRetries: loadConfig(paths).retries,
    loadSavedWorkflow: (name) => dirs.resolve(name),
    orchestrator: {
      maxNestingDepth: 5,
      pauseOnFailedStep: true,
      // What an agent may pick with choose({ any: true }). Workflows for people only stay out.
      listSavedWorkflows: () =>
        dirs
          .list()
          .filter((entry) => entry.meta && (entry.meta as { startedBy?: unknown }).startedBy !== "people")
          .map((entry) => ({ name: entry.name, ...(entry.meta?.description ? { description: entry.meta.description } : {}) })),
      prepareNestedPlace: ({ place, childRunId, cwd }) => {
        if (!isPlace(place)) throw new Error(`place must be worktree, folder or none, got "${place}"`);
        const prepared = preparePlace(paths, place, childRunId, cwd);
        noteNested(paths, childRunId, { cwd: prepared.cwd, ...(prepared.branch ? { branch: prepared.branch } : {}) });
        return { cwd: prepared.cwd };
      },
      // A nested run gets the same inputs check and defaults as one started from the command line.
      prepareNestedArgs: ({ name, script, args, childRunId, label }) => {
        noteNested(paths, childRunId, { workflow: name, ...(label ? { label } : {}) });
        if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) return args;
        const extras = workflowExtras(parseWorkflowScript(script).meta as unknown as Record<string, unknown>);
        const checked = checkInputs(extras, (args ?? {}) as Record<string, unknown>);
        if (checked.problems.length) throw new Error(`workflow("${name}"): ${checked.problems.join("; ")}`);
        return checked.args;
      },
    },
    ...extra,
  });
}

/** Run or resume one run in this process. Resolves with the engine's result. */
export async function runWorker(runId: string, mode: "start" | "resume", options: WorkerOptions = {}): Promise<WorkflowRunResult | undefined> {
  const paths = ensureHome(options.paths ?? homePaths());
  const config = loadConfig(paths);
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const record = loadRecord(paths, runId);
  if (!record) throw new Error(`no run ${runId}`);
  updateRecord(paths, runId, { pid: process.pid });

  const secrets = loadSecrets(paths);
  const mcpServers = loadMcpServers(record.projectDir, paths, { ...process.env, ...secrets });
  const slots = new SlotPool(paths.slots, paths.queue, () => loadConfig(paths).maxAgents, record.priority);
  const runner = createOrcRunner({
    cwd: record.cwd,
    inner: options.inner ?? (await loadInner()),
    slots,
    mcpServers,
    // Code steps also get the project folder, since a run may work elsewhere (a worktree, a scratch folder).
    env: { ...secrets, ORC_PROJECT: record.projectDir },
    onSlot: ({ label, state }) => {
      if (state === "waiting" && slots.held().length >= Math.max(1, loadConfig(paths).maxAgents)) {
        log(`${stamp()} queued     ${label ?? "agent"} waits for a free agent slot`);
      }
    },
  });
  const manager = managerFor(paths, record.projectDir);

  const waits = new AbortController();
  const pollMs = options.pollMs ?? 500;
  const confirm = (prompt: string, checkpoint: { kind?: "confirm" | "input" | "select"; choices?: string[] }, context?: { callIndex: number; hash: string; scope: string }) => {
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
      breakpoint: prompt.startsWith("Breakpoint: "),
      askedAt: new Date().toISOString(),
    };
    return new Promise<unknown>((resolve, reject) => {
      const take = () => {
        const answer = readAnswer(paths, id);
        if (answer && answer.hash === question.hash) {
          removeQuestion(paths, id);
          log(`${stamp()} answered   ${id}: ${oneLine(JSON.stringify(answer.value))}`);
          resolve(answer.value);
          return true;
        }
        return false;
      };
      if (take()) return;
      writeQuestion(paths, question);
      const how = question.breakpoint
        ? `orc approve ${id}  |  orc send-back ${id} "note"  |  orc stop ${runId}`
        : `orc answer ${id} "..."`;
      log(`${stamp()} question   ${id}: ${oneLine(prompt, 400)}\n           answer with: ${how}`);
      notify(`${record.workflow} asks`, oneLine(prompt, 200), config.notify);
      const timer = setInterval(() => {
        if (take()) clearInterval(timer);
      }, pollMs);
      waits.signal.addEventListener("abort", () => {
        clearInterval(timer);
        reject(new Error("stopped waiting"));
      }, { once: true });
    });
  };

  manager.on("agentStart", (event) => {
    log(`${stamp()} start      ${event.label}${event.model ? ` (${event.model})` : ""}`);
  });
  manager.on("agentEnd", (event) => {
    const tokens = event.tokens ? `, ${event.tokens} tokens` : "";
    if (event.error) log(`${stamp()} failed     ${event.label}: ${oneLine(event.error)}${tokens}`);
    else log(`${stamp()} done       ${event.label}${tokens}`);
  });
  manager.on("log", (event) => log(`${stamp()} log        ${oneLine(event.message, 400)}`));
  manager.on("phase", (event) => log(`${stamp()} phase      ${event.title}`));

  let stopping = false;
  const onPause = () => {
    log(`${stamp()} pausing`);
    manager.pause(runId);
  };
  const onStop = () => {
    stopping = true;
    log(`${stamp()} stopping`);
    manager.stop(runId);
  };
  if (options.handleSignals) {
    process.on("SIGUSR1", onPause);
    process.on("SIGTERM", onStop);
    process.on("SIGINT", onStop);
  }

  const exec = {
    agent: runner,
    cwd: record.cwd,
    confirm: confirm as never,
    ...(record.concurrency ? { concurrency: record.concurrency } : {}),
    ...(record.overrides ? { stepOverrides: record.overrides } : {}),
    ...(record.defaultModel ?? config.defaultModel ? { defaultModel: record.defaultModel ?? config.defaultModel } : {}),
  };

  let result: WorkflowRunResult | undefined;
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
      const script = existsSync(record.file) ? readFileSync(record.file, "utf8") : undefined;
      // The engine keeps the place and the model from the start, so a resume passes neither.
      const { cwd: _cwd, defaultModel: _model, ...controls } = exec as typeof exec & { defaultModel?: string };
      const resumed = await manager.resumeInBackground(runId, { ...controls, ...(script ? { script } : {}) });
      if (!resumed.accepted) {
        const state = manager.getPersistence().load(runId);
        throw new Error(`run ${runId} cannot resume (status ${state?.status ?? "unknown"}${state?.reason ? `: ${state.reason}` : ""})`);
      }
      result = await resumed.promise.catch(() => undefined);
    }
  } finally {
    waits.abort();
    if (options.handleSignals) {
      process.off("SIGUSR1", onPause);
      process.off("SIGTERM", onStop);
      process.off("SIGINT", onStop);
    }
    await runner.dispose().catch(() => {});
  }

  const state = manager.getPersistence().load(runId);
  const status = result?.status ?? state?.status ?? "unknown";
  if (status !== "paused" || stopping) removeRunQuestions(paths, runId);
  updateRecord(paths, runId, { pid: undefined });
  const reason = state?.pauseReason ? ` (${state.pauseReason}${state.resetHint ? `, ${state.resetHint}` : ""})` : "";
  const error = result?.reason ?? state?.reason;
  log(`${stamp()} ${status.padEnd(10)} ${record.workflow}${reason}${status === "failed" && error ? `: ${oneLine(String(error), 400)}` : ""}`);
  if (status === "completed" || status === "aborted") {
    for (const dir of dropUnchangedWorktrees(paths, record.projectDir, runId)) log(`${stamp()} removed    ${dir}, which changed no file`);
  }
  // A scheduled run speaks up only when it needs the user or fails.
  const quiet = record.origin === "schedule" && (status === "completed" || status === "aborted");
  if (!quiet) {
    notify(
      `${record.workflow} ${status}`,
      status === "paused" ? `paused${reason}. orc resume ${runId}` : status === "failed" ? oneLine(String(error ?? "failed"), 200) : `run ${runId}`,
      config.notify,
    );
  }
  return result;
}

/** The detached process: `orc _worker <runId> start|resume`. */
export async function workerMain(runId: string, mode: "start" | "resume"): Promise<number> {
  // The agents' shells inherit it, so `orc run` knows when an agent starts a workflow.
  process.env.ORC_RUN_ID = runId;
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

export type { RunRecord };
