// The architecture, as a test.
//
// It runs none of the app. It reads the source and checks the packages, what each file imports,
// and where a few ideas live, against the tables below. A package's tests reach another package
// only through its entries, as its callers do. The tables are the architecture. Change
// them in a commit of their own, and never to turn a red test green. When a rule fails, move the
// code to the place that owns it.
//
// Each rule starts with the places that break it today, in BREAKS. That list can only shrink. The
// test fails when a new break appears, and when a listed break is already gone, so the list stays
// true. The refactor is done when every list is empty.
//
// ARCH_PRINT=1 node --test test/architecture.test.mjs prints the breaks found now.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(import.meta.url)("typescript");

// ── The tables ──────────────────────────────────────────────────────────────────────────────────

/** Our npm scope. The fork's scope, @automatalabs, must be gone. */
const SCOPE = "@sous";

/** The only packages. cli is the sous command, engine the backend, harnesses the programs. */
const PACKAGES = ["cli", "engine", "harnesses"];

/** Old folder names of the table's packages, while the refactor moves them. Empty at the end. */
const OLD_NAMES = {};

/**
 * What each package may import besides node's own modules and its own files. Ours are named
 * without the scope. cli imports only the engine, the engine reaches the programs only through
 * the harnesses' public entry, and the harnesses import nothing of ours.
 */
const MAY_IMPORT = {
  cli: { ours: ["engine"], outside: [] },
  engine: { ours: ["harnesses"], outside: ["typebox", "acorn", "yaml", "smol-toml"] },
  harnesses: { ours: [], outside: ["@anthropic-ai/claude-agent-sdk", "typebox", "yaml", "smol-toml"] },
};

/** No file of any package imports these. */
const NEVER_IMPORT = ["@agentclientprotocol/", "@zed-industries/", "@automatalabs/", "@openai/codex-sdk", "@openai/codex"];

/** One folder per harness adapter in packages/harnesses/src. An adapter never imports another. */
const HARNESSES = ["claude", "codex"];

/**
 * Each package's test script runs through this file. It gives the tests a temporary home and
 * temporary login folders, and removes the Claude token.
 */
const TEST_RUNNER = "test/with-temp-home.mjs";

/** A test file of a package. */
const TEST_FILE = /\.test\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

/** The tests every adapter passes against a fake program. It names each adapter. */
const CONTRACT_TEST = "packages/harnesses/test/contract.test.ts";

/**
 * One home per idea. A source file outside the home that matches the pattern is a break.
 * Tests are not checked.
 */
const HOMES = [
  {
    idea: "run files: the record, its log, its questions, its snapshot, its events and the agent cap",
    pattern: /\bpaths\.(records|inbox|logs|slots|queue)\b|["'`](records|inbox|logs|slots|queue)["'`]|\.events\.jsonl|\.lineage\b|\bruns[Dd]ir\b/,
    home: ["packages/engine/src/runs/store.ts", "packages/engine/src/runs/persistence/"],
  },
  {
    idea: "making a git worktree",
    pattern: /["'`]worktree["'`]\s*,\s*["'`]add["'`]|worktree add/,
    home: ["packages/engine/src/places/"],
  },
  {
    // An account becomes these variables inside its program's adapter, and only there.
    idea: "naming a program's login or folder variable",
    pattern: /\b(CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CONFIG_DIR|CODEX_HOME)\b/,
    home: ["packages/harnesses/src/claude/", "packages/harnesses/src/codex/"],
  },
  {
    idea: "starting codex",
    pattern: /app-server/,
    home: ["packages/harnesses/src/codex/"],
  },
  {
    idea: "importing the Claude Agent SDK",
    pattern: /from\s+["'`]@anthropic-ai\/claude-agent-sdk|import\(\s*["'`]@anthropic-ai\/claude-agent-sdk/,
    home: ["packages/harnesses/src/claude/"],
  },
  {
    // Only the worker builds a run manager. The manager's own error message names the call in
    // quotes, which is not a build.
    idea: "building a run manager",
    pattern: /(?<![`'"])\bnew WorkflowManager\(/,
    home: ["packages/engine/src/runs/worker.ts"],
  },
  {
    // The workflow core never picks a home.
    idea: "finding the user's home folder",
    pattern: /\bhomedir\(/,
    home: [
      "packages/engine/src/runs/home.ts",
      "packages/engine/src/workflow-paths.ts",
      "packages/engine/src/agents.ts",
      "packages/engine/src/accounts.ts",
      "packages/harnesses/src/lookup.ts",
      "packages/harnesses/src/claude/program.ts",
      "packages/harnesses/src/codex/program.ts",
    ],
  },
  {
    // The core, the manager and the rule modules take their settings as arguments.
    idea: "reading the environment",
    pattern: /\bprocess\.env\b/,
    home: [
      "packages/engine/src/runs/home.ts",
      "packages/engine/src/runs/launch.ts",
      "packages/engine/src/runs/notify.ts",
      "packages/engine/src/runs/worker.ts",
      "packages/engine/src/agents.ts",
      "packages/engine/src/code-steps.ts",
      "packages/engine/src/workflows/check.ts",
      "packages/cli/src/",
      "packages/harnesses/src/types.ts",
      "packages/harnesses/src/lookup.ts",
      "packages/harnesses/src/claude/program.ts",
      "packages/harnesses/src/codex/program.ts",
    ],
  },
  {
    idea: "running a script in a node:vm context",
    pattern: /["'`](node:)?vm["'`]/,
    home: ["packages/engine/src/workflow.ts", "packages/engine/src/rejection-tripwire.ts"],
  },
];

/** The engine exports only what cli calls, and the harnesses only what the engine calls. */
const CALLERS = { engine: "cli", harnesses: "engine" };

/** The node modules that touch the machine: files, processes, the system, the network and vm. */
const MACHINE = /^(node:)?(fs|fs\/promises|child_process|os|vm|net|http|https|worker_threads)$/;

/**
 * The only source files that import a MACHINE module. Every other file is pure, so a new file
 * starts pure until a commit adds it here.
 */
const TOUCHES_MACHINE = [
  "packages/engine/src/accounts.ts",
  "packages/engine/src/agents.ts",
  "packages/engine/src/code-steps.ts",
  "packages/engine/src/json-file.ts",
  "packages/engine/src/places/places.ts",
  "packages/engine/src/programs.ts",
  "packages/engine/src/run-environment.ts",
  "packages/engine/src/runs/home.ts",
  "packages/engine/src/runs/inbox.ts",
  "packages/engine/src/runs/launch.ts",
  "packages/engine/src/runs/notify.ts",
  "packages/engine/src/runs/persistence/logger.ts",
  "packages/engine/src/runs/persistence/run-event-persistence.ts",
  "packages/engine/src/runs/persistence/run-persistence.ts",
  "packages/engine/src/runs/records.ts",
  "packages/engine/src/runs/run.ts",
  "packages/engine/src/runs/service.ts",
  "packages/engine/src/runs/slots.ts",
  "packages/engine/src/runs/store.ts",
  "packages/engine/src/runs/worker.ts",
  "packages/engine/src/testing.ts",
  "packages/engine/src/workflow-paths.ts",
  "packages/engine/src/workflow.ts",
  "packages/engine/src/workflows/check.ts",
  "packages/engine/src/workflows/dir.ts",
  "packages/engine/src/workflows/dry-run.ts",
  "packages/harnesses/src/claude/program.ts",
  "packages/harnesses/src/codex/program.ts",
  "packages/harnesses/src/codex/rpc.ts",
  "packages/harnesses/src/codex/run.ts",
  "packages/harnesses/src/lookup.ts",
  "packages/cli/src/account-cli.ts",
  "packages/cli/src/cli.ts",
];

/** The rule modules decide from what they are given. They read no file and start no process. */
const RULE_MODULES = [
  "packages/engine/src/checkpoint-call.ts",
  "packages/engine/src/failed-attempt.ts",
  "packages/engine/src/resume-matcher.ts",
  "packages/engine/src/resume-pairing.ts",
  "packages/engine/src/resume-report.ts",
  "packages/engine/src/resume-rows.ts",
  "packages/engine/src/run-rows.ts",
  "packages/engine/src/runs/cron.ts",
  "packages/engine/src/runs/rule.ts",
  "packages/engine/src/step-ledger.ts",
  "packages/engine/src/steps/answer.ts",
];

/** The workflow core. It runs one workflow, and the worker around it handles the run. */
const CORE = ["packages/engine/src/workflow.ts", "packages/engine/src/workflow-manager.ts", "packages/engine/src/sous-globals.ts", "packages/engine/src/steps/"];

/**
 * Files that never reach certain files of their package at run time, through their own imports
 * or through the files they import. Importing a type is fine. A path that ends in "/" names a
 * folder. `except` names files of `never` that may be reached.
 */
const NEVER_REACH = [
  {
    // The core runs workflows. The worker hands it the places of a run tree, and the core never
    // picks a home or writes the run record.
    from: ["packages/engine/src/workflow.ts", "packages/engine/src/workflow-manager.ts", "packages/engine/src/places/"],
    never: ["packages/engine/src/runs/records.ts", "packages/engine/src/runs/home.ts"],
  },
  {
    // The core runs a workflow on what it is handed. It knows nothing of runs other than the
    // persistence folder and the cron parser.
    from: CORE,
    never: ["packages/engine/src/runs/"],
    except: ["packages/engine/src/runs/persistence/", "packages/engine/src/runs/cron.ts"],
  },
  { from: RULE_MODULES, never: TOUCHES_MACHINE },
  {
    // The persistence folder writes what it is handed. It knows nothing of the rest of runs, of
    // the core or of the saved workflows.
    from: ["packages/engine/src/runs/persistence/"],
    never: ["packages/engine/src/runs/", ...CORE, "packages/engine/src/workflows/"],
    except: ["packages/engine/src/runs/persistence/"],
  },
];

/**
 * The 36 behavior changes of docs/history/improve.md, each with the tests that hold it. A test is a
 * file and the title its test() or it() call gets, or the title of a describe() with a test under
 * it. The rule fails when a title is no longer a test of its file, or when the test is skipped.
 * A title that the source builds from a template stays as the source writes it, ${...} included,
 * and a third part names the case of the file that the title stands for. A change with no test
 * yet has `waiting` in place of `tests`, and the test run lists it as todo. A later commit adds
 * its tests. A comment on a change says where its tests hold it only in part.
 *
 * A test that holds a change keeps its file and its title. A cut or a merge keeps them too.
 */
const PINS = [
  // Runs
  { change: "A run paused for a lost login resumes once the login is back", tests: [
    ["packages/cli/test/runs.test.ts", "a run paused for a lost login pauses again while the login is gone, says why, and resumes once the person logs in again"],
    ["packages/engine/test/runs/rule.test.ts", "${row}: ${expected.word}", '"paused, auth_required"'],
  ] },
  { change: "A step's time limit counts from when it holds a slot", tests: [
    ["packages/cli/test/runs.test.ts", "a step's time limit counts from when it starts running, not while it waits for a free slot"],
  ] },
  { change: "choose() takes the run's step changes like agent()", tests: [
    ["packages/cli/test/runs.test.ts", "per-run step changes reach the agent that choose() asks"],
  ] },
  { change: "A step that sets tier stops with an error", tests: [
    ["packages/engine/test/runs/call-hash-pin.test.ts", "refuses a step with a tier, so no call keeps a hash for it"],
  ] },
  { change: "A script that calls verify, judgePanel, loopUntilDry or completenessCheck fails with a ReferenceError", tests: [
    ["packages/engine/test/script-functions.test.ts", "a script that calls verify fails with a ReferenceError"],
    ["packages/engine/test/script-functions.test.ts", "a script that calls judgePanel fails with a ReferenceError"],
    ["packages/engine/test/script-functions.test.ts", "a script that calls loopUntilDry fails with a ReferenceError"],
    ["packages/engine/test/script-functions.test.ts", "a script that calls completenessCheck fails with a ReferenceError"],
  ] },
  { change: "A run whose worker died while another process held its lock reads as interrupted with exit 2", tests: [
    ["packages/cli/test/reads.test.ts", "write no file"],
    ["packages/engine/test/runs/rule.test.ts", "${row}: ${expected.word}", '"running, worker gone"'],
  ] },
  { change: "The state saves when the run paused, once", tests: [
    ["packages/cli/test/accounts.test.ts", "a limit with no reset time is tried again 30 minutes after the pause, whatever saves the state later"],
  ] },
  { change: "ask(\"Breakpoint: ...\") is a plain question", tests: [
    ["packages/cli/test/runs.test.ts", "a question whose text starts like a breakpoint's is a plain question, which send-back refuses"],
  ] },
  { change: "sous stop --step writes its request to a file of its own", tests: [
    ["packages/cli/test/runs.test.ts", "a step stop survives the worker saving a record it read before the request"],
    ["packages/cli/test/runs.test.ts", "a step stop left by a worker that ended is dropped when the next worker starts"],
  ] },
  { change: "sous stop --step build stops the step that sous log names build", tests: [
    ["packages/cli/test/runs.test.ts", "stopping a step by its name stops only that step, not a nested step with the same label"],
  ] },
  { change: "sous doctor --live --model haiku runs haiku", tests: [
    ["packages/engine/test/programs.test.ts", "runs a bare model name on the harness it routes to, and says so"],
    ["packages/cli/test/doctor.test.ts", "with --live --model, runs that model on its program alone"],
  ] },
  { change: "The worker's last log line for a run paused on a failed step says why", tests: [
    ["packages/engine/test/runs/worker-log.test.ts", "says why a step failed, on a start and on a resume alike"],
  ] },
  { change: "The run's log gets a note line when a program could not do what a step asked", tests: [
    ["packages/engine/test/steps.test.ts", "reports once per step what its program could not do as asked, also when the step fails"],
    ["packages/cli/test/note-line.test.ts", "names the step and what its program could not do, once, between the step's start and its end"],
  ] },
  { change: "An MCP server of a type a step cannot start says so", tests: [
    ["packages/engine/test/mcp-servers.test.ts", "names the server and its type when a step cannot start it"],
  ] },

  // Questions
  { change: "sous answer <q> stop at a breakpoint stops the run", tests: [
    ["packages/cli/test/questions.test.ts", "sous answer <q> stop stops a running run, as sous stop does"],
  ] },
  { change: "An answer file with no value pauses the run", tests: [
    ["packages/cli/test/answer-file.test.ts", "pauses the run, runs no step, and asks again when the run resumes"],
  ] },

  // Resume
  { change: "--latest keeps the steps that match after an edit", tests: [
    ["packages/cli/test/resume.test.ts", "with --latest and step 1 edited, keeps the steps after it"],
  ] },
  { change: "A reuse of a run that was resumed, a nested run and a loop replay their finished steps", tests: [
    ["packages/cli/test/resume.test.ts", "reuses the steps of a resumed run after an edited first step"],
    ["packages/cli/test/resume.test.ts", "reuses the steps of a nested workflow"],
  ] },
  { change: "A paused reuse run keeps its source's steps when it resumes", tests: [
    ["packages/cli/test/resume.test.ts", "resumes a paused reuse run with its source's later steps"],
  ] },
  { change: "A stale journal row under a later call no longer replays", tests: [
    ["packages/engine/test/runs/resume-moved-rows.test.ts", "runs a step live after two failed resumes moved an identical step's row"],
    ["packages/engine/test/resume-rows.test.ts", "joins the journal and the call rows of a scope by index"],
  ] },
  { change: "On a resume, an agent step that returned a blank result with no schema runs again", tests: [
    ["packages/engine/test/incremental-engine-resume.test.ts", "runs live a step whose recorded text is blank, unless the step has a schema"],
  ] },
  // Both tests read the saved state with readState. No test reads it from sous show --json.
  { change: "sous show --json shows the strategy occurrence-v1 and the match occurrence", tests: [
    ["packages/cli/test/resume.test.ts", "with --latest and step 1 edited, keeps the steps after it"],
    ["packages/cli/test/resume.test.ts", "reuses the steps of a resumed run after an edited first step"],
  ] },

  // Accounts and clean-up
  { change: "A second sous account use spare, after a move whose worker did not start, retries the resume", tests: [
    ["packages/cli/test/accounts.test.ts", "sous account use goes by the account whose limit a run hit, so a second use after a move whose worker did not start tries again"],
    ["packages/engine/test/runs/run.test.ts", "lists the runs whose worker is gone and that paused at the limit, newest first, each with the account whose limit it hit"],
  ] },
  { change: "Forgetting or pruning a run removes its open questions", tests: [
    ["packages/engine/test/runs/forget.test.ts", "forgetRun removes the run's open question from the inbox"],
  ] },
  { change: "sous prune and the service skip a run while another process holds its lock", tests: [
    ["packages/engine/test/runs/forget.test.ts", "with a lock held by a live process, pruneRuns keeps the finished run whole"],
  ] },
  { change: "A forgotten or pruned run leaves no file behind", tests: [
    ["packages/engine/test/runs/layout.test.ts", "a forgotten run leaves only the home's folders"],
    ["packages/engine/test/runs/forget.test.ts", "pruneRuns removes the same files once the run is older than the days given"],
  ] },

  // Reads
  { change: "sous list, show, wait, inbox, log and account list write nothing", tests: [
    ["packages/cli/test/reads.test.ts", "write no file"],
  ] },
  { change: "While a run is live, sous show --json gives a step what a saved step has", tests: [
    ["packages/engine/test/runs/run.test.ts", "the event log gives each step what the saved state gives it"],
  ] },
  { change: "sous show lists the steps that finished before a worker was killed as done", tests: [
    ["packages/engine/test/runs/run.test.ts", "the event log gives the steps the worker never saved, and none of them runs"],
  ] },
  { change: "sous log -f prints the no run error if the run's record is deleted just after its worker ends", tests: [
    ["packages/cli/test/reads.test.ts", "let sous log -f print the no run error, and exit 1, when the run goes away while it follows"],
  ] },

  // The library
  { change: "A reuse run that ends without an engine result lists its call rows in the order they settled", tests: [
    ["packages/engine/test/result-observability.test.ts", "a reuse run that fails before its engine returns lists its root call rows in the order they settled"],
  ] },
  { change: "A caller that passes no places object gets no home to make worktrees in", tests: [
    ["packages/engine/test/places.test.ts", "a step with isolation worktree and no places works in the run's folder, and the log says why"],
    ["packages/engine/test/sous-globals.test.ts", "with no places, a nested place of its own fails and says why, and place folder works in the parent's folder"],
  ] },
  { change: "runSync on a run that paused or failed returns the result the run saved", tests: [
    ["packages/engine/test/manager-state.test.ts", "runSync returns the result its paused or failed run kept and saved"],
  ] },
  { change: "A stopped run's result has abortSignaled", tests: [
    ["packages/engine/test/manager-state.test.ts", "a stopped run's result says its signal was aborted, as its saved state does"],
  ] },
  { change: "A resume of a run that paused for a lost login, or on a question with no confirm callback, starts the run", tests: [
    ["packages/engine/test/auth-pause.test.ts", "cold resume of an auth pause runs the step again, and the run completes once the login is back"],
    ["packages/engine/test/checkpoint.test.ts", "durable checkpoint: cold resume without a reply or live confirm pauses again at the same question"],
  ] },
  // The requests reach the worker through the file, but no test reads the file's text.
  { change: "The file of step stop requests holds one JSON object per line", tests: [
    ["packages/cli/test/runs.test.ts", "stopping a step by its name stops only that step, not a nested step with the same label"],
  ] },
];

/**
 * Size caps. A source file has at most FILE_LINES lines and a function at most FUNCTION_LINES,
 * other than the ones LINE_CAPS lists with a cap of their own. A function runs from its first line
 * to its last, the functions inside it included, as an editor shows it. An unnamed function counts
 * under the name of the function or variable that holds it. A key is a file, or a file and a
 * function's name.
 *
 * A listed cap only goes down. The test fails when its file or function is SLACK lines under it,
 * and says to lower it.
 */
const FILE_LINES = 850;
const FUNCTION_LINES = 250;
const SLACK = 50;
const LINE_CAPS = {
  "packages/engine/src/workflow.ts": 2312,
  "packages/engine/src/workflow-manager.ts": 2084,
  "packages/engine/src/workflow.ts: runLevel": 1476,
  "packages/engine/src/workflow.ts: agentImplementation": 780,
  "packages/engine/src/workflow.ts: runLive": 446,
};

/**
 * Caps on the ways into a run: the public methods of a class, or the fields of a type with the
 * ones it inherits. A public method is one with no private or protected mark, a getter, a setter,
 * or a public field that holds a function. A count only goes down. The test fails when it is over
 * its cap, and when it is under it, with the number to lower it to.
 */
const MEMBER_CAPS = [
  { file: "packages/engine/src/workflow-manager.ts", methodsOf: "WorkflowManager", cap: 11 },
  { file: "packages/engine/src/workflow.ts", fieldsOf: "WorkflowRunOptions", cap: 36 },
  { file: "packages/engine/src/workflow.ts", fieldsOf: "AgentOptions", cap: 18 },
];

/**
 * The number of test files that build a WorkflowManager themselves. The source builds it in one
 * place, runs/worker.ts, and each of these files changes when the manager's interface does. New
 * tests go through runs/run.ts or the test kit. The number only goes down.
 */
const MANAGER_BUILDERS = 25;

/** The README whose "Inside" table names each top-level file and folder of the package's src. */
const INSIDE = { readme: "packages/engine/README.md", src: "packages/engine/src" };

// ── The breaks of today. They can only go. ──────────────────────────────────────────────────────

const BREAKS = {
  packages: [],
  imports: [],
  cycles: [],
  homes: [],
  reach: [
    "packages/engine/src/sous-globals.ts imports packages/engine/src/runs/inbox.ts",
    // Already there at bf2bf6a5. The plan missed it.
    "packages/engine/src/steps/steps.ts reaches packages/engine/src/runs/home.ts through packages/engine/src/agents.ts",
  ],
  exports: {},
  contract: [],
  tests: [],
  scripts: [],
  // Exported values that nothing imports.
  unused: [],
  // Exported values that only the package's tests import, past the interface of their module.
  forTests: [
    "packages/engine/src/agents.ts: agentDefinitionKey",
    "packages/engine/src/agents.ts: definitionOf",
    "packages/engine/src/call-path.ts: CALL_PATH_RAW_FRAMES",
    "packages/engine/src/checkpoint-call.ts: hashCheckpointInputs",
    "packages/engine/src/errors.ts: isAbortError",
    "packages/engine/src/errors.ts: isWorkflowError",
    "packages/engine/src/failed-attempt.ts: HOST_HANDLED_CODES",
    "packages/engine/src/resume-pairing.ts: pairCalls",
    "packages/engine/src/runs/inbox.ts: breakpointValue",
    "packages/engine/src/runs/persistence/project-paths.ts: WORKFLOW_PROJECTS_SUBDIR",
    "packages/engine/src/runs/persistence/project-paths.ts: workflowProjectKey",
    "packages/engine/src/runs/persistence/run-event-persistence.ts: RUN_EVENT_MAX_RECORD_BYTES",
    "packages/engine/src/runs/persistence/run-event-persistence.ts: RUN_EVENT_READ_LIMIT_MAX",
    "packages/engine/src/runs/persistence/run-event-persistence.ts: RunEventLogError",
    "packages/engine/src/runs/persistence/run-persistence.ts: inlineScriptFile",
    "packages/engine/src/runs/rule.ts: parseResetHint",
    "packages/engine/src/runs/run.ts: busyWorktrees",
    "packages/engine/src/steps/answer.ts: findJsonBlock",
    "packages/engine/src/workflow-paths.ts: WORKFLOW_HOME_RELATIVE_DIR",
    "packages/engine/src/workflow.ts: sanitizeVmName",
    "packages/harnesses/src/tools.ts: matches",
  ],
};

// ── Reading the source ──────────────────────────────────────────────────────────────────────────

const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const SKIP = new Set(["node_modules", "dist", "generated", "build", "coverage"]);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (SOURCE.test(name) && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

const rel = (path) => relative(ROOT, path).split(sep).join("/");

function packageDirs() {
  return readdirSync(join(ROOT, "packages")).filter((name) => existsSync(join(ROOT, "packages", name, "package.json")));
}

/** The table name of a package folder, or undefined for a package that must go. */
function role(dir) {
  if (PACKAGES.includes(dir)) return dir;
  return OLD_NAMES[dir];
}

/**
 * Imports of one file: the specifier, the names it takes, and whether it takes only types, read
 * from the parsed file.
 */
const sources = new Map();
/** The parsed source of a file, read once. */
function sourceOf(file) {
  if (!sources.has(file)) sources.set(file, ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true));
  return sources.get(file);
}

const imported = new Map();
function importsOf(file) {
  if (!imported.has(file)) imported.set(file, readImports(file));
  return imported.get(file);
}

function readImports(file) {
  const source = sourceOf(file);
  const found = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const names = [];
      let star = false;
      const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
      if (clause?.name) names.push("default");
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const el of bindings.elements) names.push((el.propertyName ?? el.name).text);
      if (bindings && ts.isNamespaceImport(bindings)) star = true;
      if (ts.isExportDeclaration(node)) {
        if (node.exportClause && ts.isNamedExports(node.exportClause)) for (const el of node.exportClause.elements) names.push((el.propertyName ?? el.name).text);
        else star = true;
      }
      const elements = (bindings && ts.isNamedImports(bindings) ? bindings.elements : undefined)
        ?? (node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : undefined);
      const typeOnly = Boolean(clause?.isTypeOnly || (ts.isExportDeclaration(node) && node.isTypeOnly)
        || (!clause?.name && elements?.length && elements.every((el) => el.isTypeOnly)));
      found.push({ spec: node.moduleSpecifier.text, names, star, typeOnly });
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) {
        found.push({ spec: node.arguments[0].text, names: [], star: true });
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      found.push({ spec: node.moduleReference.expression.text, names: [], star: true });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const BUILTIN = new Set(builtinModules);

/** The npm package of a specifier: "@a/b/c" is "@a/b", "x/y" is "x". */
function npmName(spec) {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Our package a specifier names, without the scope, or undefined. */
function oursName(spec) {
  const match = /^@(sous|automatalabs)\/([^/]+)/.exec(spec);
  if (!match) return undefined;
  const name = match[2];
  if (name === "workflow-engine") return "engine";
  return name;
}

function collect() {
  const dirs = packageDirs();
  const files = [];
  const tests = [];
  for (const dir of dirs) {
    for (const file of walk(join(ROOT, "packages", dir, "src"))) files.push({ dir, role: role(dir), file, path: rel(file) });
    for (const file of walk(join(ROOT, "packages", dir, "test"))) tests.push({ dir, file, path: rel(file) });
  }
  return { dirs, files, tests };
}

// ── The rules ───────────────────────────────────────────────────────────────────────────────────

function packageBreaks({ dirs }) {
  const found = [];
  for (const dir of dirs) if (!PACKAGES.includes(dir)) found.push(OLD_NAMES[dir] ? `${dir} is still named for ${OLD_NAMES[dir]}` : `${dir} must go`);
  for (const name of PACKAGES) if (!dirs.includes(name)) found.push(`${name} is missing`);
  for (const dir of dirs) {
    const pkg = JSON.parse(readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8"));
    if (role(dir) && pkg.name !== `${SCOPE}/${role(dir)}`) found.push(`${dir} is published as ${pkg.name}`);
  }
  return found;
}

function importBreaks({ files, dirs, tests }) {
  const found = new Set();
  for (const { dir, role: name, file, path } of files) {
    for (const { spec } of importsOf(file)) {
      for (const never of NEVER_IMPORT) {
        if (spec === never || spec.startsWith(never.endsWith("/") ? never : `${never}/`)) found.add(`${dir} imports ${never.endsWith("/") ? `${never}*` : never}`);
      }
      if (!name) continue;
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec);
        const own = join(ROOT, "packages", dir);
        if (!target.startsWith(own + sep)) found.add(`${path} reaches outside its package with ${spec}`);
        if (name === "harnesses") {
          const from = /^packages\/harnesses\/src\/([^/]+)\//.exec(path)?.[1];
          const to = /^packages\/harnesses\/src\/([^/]+)\//.exec(rel(target))?.[1];
          if (from && to && from !== to && HARNESSES.includes(from) && HARNESSES.includes(to)) found.add(`${path} is the ${from} adapter and imports the ${to} adapter`);
        }
        continue;
      }
      if (spec.startsWith("node:") || BUILTIN.has(npmName(spec))) continue;
      const ours = oursName(spec);
      if (ours) {
        if (ours === name) continue;
        if (!MAY_IMPORT[name].ours.includes(ours)) found.add(`${name} imports ${ours}`);
        else if (spec.split("/").length > 2) found.add(`${name} imports ${spec}, past the public entry`);
        continue;
      }
      if (!MAY_IMPORT[name].outside.includes(npmName(spec))) found.add(`${name} imports ${npmName(spec)}`);
    }
  }
  // A test takes another package's parts from its entries, such as the engine's test kit at
  // @sous/engine/testing, never by a path into that package's src or dist.
  for (const { dir, file, path } of tests) {
    for (const { spec } of importsOf(file)) {
      if (spec.startsWith(".") && !resolve(dirname(file), spec).startsWith(join(ROOT, "packages", dir) + sep)) found.add(`${path} reaches outside its package with ${spec}`);
    }
  }
  for (const dir of dirs) {
    const name = role(dir);
    if (!name) continue;
    const pkg = JSON.parse(readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8"));
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      const ours = oursName(dep);
      const allowed = ours ? ours === name || MAY_IMPORT[name].ours.includes(ours) : MAY_IMPORT[name].outside.includes(dep);
      if (!allowed) found.add(`${name} depends on ${ours ?? dep}`);
    }
  }
  return [...found].sort();
}

function homeBreaks({ files }) {
  const found = new Set();
  for (const { dir, role: name, file, path } of files) {
    const text = readFileSync(file, "utf8");
    for (const { idea, pattern, home } of HOMES) {
      if (!pattern.test(text)) continue;
      if (home.some((place) => (place.endsWith("/") ? path.startsWith(place) : path === place))) continue;
      found.add(name ? `${idea}, in ${path}` : `${idea}, in packages/${dir}`);
    }
  }
  return [...found].sort();
}

/** Whether a path is one of the places, where a place that ends in "/" is a folder. */
const within = (path, places) => places.some((place) => (place.endsWith("/") ? path.startsWith(place) : path === place));

/** The source files a file imports at run time: every import of ours that is not type-only. */
function runTimeImports(file, known) {
  const out = [];
  for (const { spec, typeOnly } of importsOf(file)) {
    if (typeOnly || !spec.startsWith(".")) continue;
    const target = rel(resolve(dirname(file), spec)).replace(/\.js$/, ".ts");
    if (known.has(target)) out.push(target);
  }
  return out;
}

function reachBreaks({ files }) {
  const found = new Set();
  const known = new Map(files.map(({ file, path }) => [path, file]));
  for (const { from, never, except = [] } of NEVER_REACH) {
    const starts = [...known.keys()].filter((path) => within(path, from));
    for (const start of starts) {
      // Each file this one reaches at run time, and the file that imports it on the way.
      const importer = new Map([[start, undefined]]);
      const queue = [start];
      while (queue.length) {
        const path = queue.shift();
        for (const target of runTimeImports(known.get(path), known)) {
          if (importer.has(target)) continue;
          importer.set(target, path);
          if (within(target, never) && !within(target, except)) {
            found.add(path === start ? `${start} imports ${target}` : `${start} reaches ${target} through ${path}`);
          } else if (!within(target, from)) {
            // A file of `from` is a start of its own, so its breaks show once, under its name.
            queue.push(target);
          }
        }
      }
    }
  }
  return [...found].sort();
}

/**
 * Each loop of run-time imports between source files, from its first file in sort order. A
 * dynamic import counts, as it does for the reach rule.
 */
function cycleBreaks({ files }) {
  const known = new Map(files.map(({ file, path }) => [path, file]));
  const found = new Set();
  const done = new Set();
  const stack = [];
  const visit = (path) => {
    stack.push(path);
    for (const target of runTimeImports(known.get(path), known)) {
      const at = stack.indexOf(target);
      if (at >= 0) {
        const loop = stack.slice(at);
        const first = loop.indexOf([...loop].sort()[0]);
        found.add([...loop.slice(first), ...loop.slice(0, first), loop[first]].join(" imports "));
      } else if (!done.has(target)) visit(target);
    }
    stack.pop();
    done.add(path);
  };
  for (const path of [...known.keys()].sort()) if (!done.has(path)) visit(path);
  return [...found].sort();
}

/** Each file that imports a MACHINE module and is not listed, and each listed file that does not. */
function machineBreaks({ files }) {
  const found = [];
  const paths = new Set(files.map(({ path }) => path));
  for (const { file, path } of files) {
    const touched = [...new Set(importsOf(file).map(({ spec }) => spec).filter((spec) => MACHINE.test(spec)))];
    const listed = TOUCHES_MACHINE.includes(path);
    if (touched.length && !listed) found.push(`${path} imports ${touched.join(", ")}. Keep it pure, or add it to TOUCHES_MACHINE in a commit of its own.`);
    if (!touched.length && listed) found.push(`${path} is pure now. Remove it from TOUCHES_MACHINE.`);
  }
  for (const path of TOUCHES_MACHINE) if (!paths.has(path)) found.push(`${path} is gone. Remove it from TOUCHES_MACHINE.`);
  return found.sort();
}

/** One type-checked program per package, from its public entry and the files MEMBER_CAPS names. */
const programs = new Map();
function programOf(dir) {
  if (!programs.has(dir)) {
    const roots = [join(ROOT, "packages", dir, "src", "index.ts"), ...MEMBER_CAPS.filter(({ file }) => file.startsWith(`packages/${dir}/`)).map(({ file }) => join(ROOT, file))];
    programs.set(dir, ts.createProgram(roots.filter((root) => existsSync(root)), { allowJs: false, noEmit: true, skipLibCheck: true, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022 }));
  }
  return programs.get(dir);
}

/** Each exported name of a package's public entry, read by the type checker. */
function exportedNames(dir) {
  const entry = join(ROOT, "packages", dir, "src", "index.ts");
  if (!existsSync(entry)) return [];
  const program = programOf(dir);
  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(program.getSourceFile(entry));
  return symbol ? checker.getExportsOfModule(symbol).map((s) => s.getName()).sort() : [];
}

function exportBreaks({ files, dirs }) {
  const found = {};
  for (const [pkg, caller] of Object.entries(CALLERS)) {
    const dir = dirs.find((d) => role(d) === pkg);
    if (!dir) continue;
    const used = new Set();
    let star = false;
    for (const f of files) {
      if (f.role !== caller) continue;
      for (const { spec, names, star: all } of importsOf(f.file)) {
        if (oursName(spec) !== pkg) continue;
        names.forEach((n) => used.add(n));
        star ||= all;
      }
    }
    const unused = star ? [] : exportedNames(dir).filter((n) => !used.has(n));
    if (star) found[`${caller} imports all of ${pkg} at once`] = 1;
    if (unused.length) found[`${pkg} exports names ${caller} never imports`] = unused.length;
  }
  return found;
}

function contractBreaks() {
  const found = [];
  const src = join(ROOT, "packages", "harnesses", "src");
  const adapters = existsSync(src) ? readdirSync(src).filter((n) => statSync(join(src, n)).isDirectory()) : [];
  for (const name of HARNESSES) if (!adapters.includes(name)) found.push(`the ${name} adapter is missing`);
  for (const name of adapters) if (!HARNESSES.includes(name) && name !== "shared") found.push(`${name} is an adapter the table doesn't list`);
  const contract = join(ROOT, CONTRACT_TEST);
  if (!existsSync(contract)) found.push(`${CONTRACT_TEST} is missing`);
  else {
    const text = readFileSync(contract, "utf8");
    for (const name of HARNESSES) if (!new RegExp(`["'\`]${name}["'\`]`).test(text)) found.push(`the contract test doesn't run the ${name} adapter`);
  }
  return found;
}

/**
 * The titles of the tests and the suites a file runs: the first argument of each test(), it() and
 * describe() call, other than a skipped or todo one. A suite counts when a test runs under it, so
 * a pin on a suite holds while one of its tests does. A title built from a template is the
 * template's source text.
 */
function runningTitles(file) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const titles = new Set();
  // Adds the titles under a node, and returns how many tests run under it. `off` says that a
  // skipped suite is above.
  const visit = (node, off) => {
    let kind;
    let title;
    let here = off;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.arguments.length && ["test", "it", "describe", "suite"].includes(node.expression.text)) {
      kind = node.expression.text === "describe" || node.expression.text === "suite" ? "suite" : "test";
      const [first, ...rest] = node.arguments;
      here = off || rest.some((arg) => ts.isObjectLiteralExpression(arg) && arg.properties.some((prop) => prop.name && ["skip", "todo"].includes(prop.name.getText())));
      if (ts.isStringLiteralLike(first)) title = first.text;
      else if (ts.isTemplateExpression(first)) title = first.getText().slice(1, -1);
    }
    let tests = 0;
    ts.forEachChild(node, (child) => {
      tests += visit(child, here);
    });
    if (kind === "test") {
      if (here) return 0;
      if (title !== undefined) titles.add(title);
      return 1;
    }
    if (kind === "suite" && !here && tests > 0 && title !== undefined) titles.add(title);
    return tests;
  };
  visit(source, false);
  return titles;
}

/**
 * A test file whose imports are all types, or all outside the code it tests, can run none of that
 * code. It needs a run-time import of its package's own src or of one of our packages.
 */
function testBreaks({ tests }) {
  const found = [];
  for (const { dir, file, path } of tests) {
    if (!TEST_FILE.test(path)) continue;
    const own = join(ROOT, "packages", dir, "src") + sep;
    const runs = importsOf(file).some(({ spec, typeOnly }) => !typeOnly && (oursName(spec) || (spec.startsWith(".") && resolve(dirname(file), spec).startsWith(own))));
    if (!runs) found.push(`${path} imports no run-time value of the code it tests`);
  }
  return found.sort();
}

/** The name a function goes by: its own, its variable's or its property's, with its class. */
function functionName(node) {
  const holder = node.parent;
  const named = node.name ?? (holder && (ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder) || ts.isPropertyDeclaration(holder)) ? holder.name : undefined);
  const name = ts.isConstructorDeclaration(node) ? "constructor" : named?.getText();
  if (!name) return undefined;
  const member = ts.isClassLike(holder) ? holder : ts.isPropertyDeclaration(holder) && ts.isClassLike(holder.parent) ? holder.parent : undefined;
  return member?.name ? `${member.name.text}.${name}` : name;
}

/** The lines of each source file, and of each function by its name, the longest of a name. */
function lineCounts({ files }) {
  const counts = new Map();
  for (const { file, path } of files) {
    const source = sourceOf(file);
    const lineOf = (pos) => source.getLineAndCharacterOfPosition(pos).line;
    counts.set(path, lineOf(source.end) + (source.text.endsWith("\n") ? 0 : 1));
    const visit = (node, owner) => {
      let name = owner;
      if (ts.isFunctionLike(node) && node.body) {
        name = functionName(node) ?? owner ?? "(unnamed function)";
        const key = `${path}: ${name}`;
        counts.set(key, Math.max(counts.get(key) ?? 0, lineOf(node.end) - lineOf(node.getStart()) + 1));
      }
      ts.forEachChild(node, (child) => visit(child, name));
    };
    visit(source, undefined);
  }
  return counts;
}

/** Each file or function over its cap, and each listed cap that is SLACK lines too high. */
function sizeBreaks(counts) {
  const found = [];
  for (const [key, lines] of counts) {
    const cap = LINE_CAPS[key] ?? (key.includes(": ") ? FUNCTION_LINES : FILE_LINES);
    if (lines > cap) found.push(`${key} has ${lines} lines, more than its cap of ${cap}. Split it.`);
  }
  for (const [key, cap] of Object.entries(LINE_CAPS)) {
    const lines = counts.get(key);
    const general = key.includes(": ") ? FUNCTION_LINES : FILE_LINES;
    if (lines === undefined) found.push(`${key} is gone. Remove it from LINE_CAPS.`);
    else if (lines <= general) found.push(`${key} has ${lines} lines, within the cap of ${general} for all. Remove it from LINE_CAPS.`);
    else if (lines <= cap - SLACK) found.push(`${key} has ${lines} lines, ${cap - lines} under its cap of ${cap}. Lower it to ${lines}.`);
  }
  return found.sort();
}

/** The count of each MEMBER_CAPS row, or undefined when its class or type is gone. */
function memberCount({ file, methodsOf, fieldsOf }) {
  const program = programOf(file.split("/")[1]);
  const source = program.getSourceFile(join(ROOT, file));
  const declaration = source?.statements.find((node) => node.name?.text === (methodsOf ?? fieldsOf) && (fieldsOf || ts.isClassDeclaration(node)));
  if (!declaration) return undefined;
  if (fieldsOf) {
    const checker = program.getTypeChecker();
    return checker.getPropertiesOfType(checker.getTypeAtLocation(declaration.name)).length;
  }
  const hidden = ts.ModifierFlags.Private | ts.ModifierFlags.Protected;
  const methods = new Set();
  for (const member of declaration.members ?? []) {
    if (!member.name || ts.isPrivateIdentifier(member.name) || ts.getCombinedModifierFlags(member) & hidden) continue;
    const callable = ts.isMethodDeclaration(member) || ts.isAccessor(member)
      || (ts.isPropertyDeclaration(member) && member.initializer && (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer)));
    if (callable) methods.add(member.name.getText());
  }
  return methods.size;
}

function memberBreaks() {
  const found = [];
  for (const row of MEMBER_CAPS) {
    const what = row.methodsOf ? `${row.methodsOf} in ${row.file} has %s public methods` : `${row.fieldsOf} in ${row.file} has %s fields`;
    const count = memberCount(row);
    if (count === undefined) found.push(`${row.methodsOf ?? row.fieldsOf} is gone from ${row.file}. Remove its row from MEMBER_CAPS.`);
    else if (count > row.cap) found.push(`${what.replace("%s", count)}, more than its cap of ${row.cap}.`);
    else if (count < row.cap) found.push(`${what.replace("%s", count)}, fewer than its cap of ${row.cap}. Lower it to ${count}.`);
  }
  return found;
}

/** A package's entries, from the exports and the bin of its package.json, as source paths. */
function entriesOf(dir) {
  const pkg = JSON.parse(readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8"));
  const targets = [...Object.values(pkg.exports ?? {}), ...Object.values(typeof pkg.bin === "string" ? [pkg.bin] : pkg.bin ?? {}), pkg.main];
  return targets
    .map((target) => (typeof target === "object" && target ? target.types ?? target.import : target))
    .filter(Boolean)
    .map((target) => `packages/${dir}/${target.replace(/^\.\//, "").replace(/^dist\//, "src/").replace(/\.js$/, ".ts")}`);
}

/** The values a file exports by name: functions, classes, variables and enums. Types are left out. */
function exportedValues(file) {
  const names = [];
  for (const node of sourceOf(file).statements) {
    const flags = ts.getCombinedModifierFlags(node);
    if (ts.isExportAssignment(node)) names.push("default");
    if (!(flags & ts.ModifierFlags.Export) || flags & ts.ModifierFlags.Ambient) continue;
    if (flags & ts.ModifierFlags.Default) names.push("default");
    else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) names.push(node.name.text);
    else if (ts.isVariableStatement(node)) {
      const bind = (name) => (ts.isIdentifier(name) ? names.push(name.text) : name.elements.forEach((el) => el.name && bind(el.name)));
      for (const declaration of node.declarationList.declarations) bind(declaration.name);
    }
  }
  return [...new Set(names)];
}

/**
 * Each exported value of a source file that is not an entry, with no importer in the source of
 * its package: `unused` when nothing imports it, `forTests` when only the package's tests do. A
 * type-only import counts. Types are not checked, since a type that only a signature uses is often
 * fine. Run knip by hand for those.
 */
function unusedExportBreaks({ files, tests, dirs }) {
  const known = new Set(files.map(({ path }) => path));
  const entries = new Set(dirs.flatMap(entriesOf));
  // For each source file, the names imported from it by source and by tests. "*" is every name.
  const takers = { source: new Map(), tests: new Map() };
  for (const [kind, list] of [["source", files], ["tests", tests]]) {
    for (const { file } of list) {
      for (const { spec, names, star } of importsOf(file)) {
        if (!spec.startsWith(".")) continue;
        const target = rel(resolve(dirname(file), spec)).replace(/\.js$/, ".ts");
        if (!known.has(target)) continue;
        if (!takers[kind].has(target)) takers[kind].set(target, new Set());
        for (const name of star ? ["*"] : names) takers[kind].get(target).add(name);
      }
    }
  }
  const takes = (kind, path, name) => takers[kind].get(path)?.has(name) || takers[kind].get(path)?.has("*");
  const unused = [];
  const forTests = [];
  for (const { file, path } of files) {
    if (entries.has(path)) continue;
    for (const name of exportedValues(file)) {
      if (takes("source", path, name)) continue;
      (takes("tests", path, name) ? forTests : unused).push(`${path}: ${name}`);
    }
  }
  return { unused: unused.sort(), forTests: forTests.sort() };
}

function scriptBreaks({ dirs }) {
  const found = [];
  if (!existsSync(join(ROOT, TEST_RUNNER))) found.push(`${TEST_RUNNER} is missing`);
  for (const dir of dirs) {
    const script = JSON.parse(readFileSync(join(ROOT, "packages", dir, "package.json"), "utf8")).scripts?.test ?? "";
    if (!script.split(" ").includes(`../../${TEST_RUNNER}`)) found.push(`${dir} runs its tests without ${TEST_RUNNER}`);
  }
  return found;
}

/** Each `src/` path in the first column of the Inside table exists, and names every top-level entry. */
function insideBreaks() {
  const text = readFileSync(join(ROOT, INSIDE.readme), "utf8");
  const table = text.slice(text.indexOf("\n## Inside\n")).split("\n## ")[1] ?? "";
  const named = new Set();
  for (const line of table.split("\n").filter((l) => l.startsWith("| `"))) {
    for (const [, path] of line.split(" | ")[0].matchAll(/`src\/([^`]+?)\/?`/g)) named.add(path);
  }
  const found = [];
  for (const path of named) if (!existsSync(join(ROOT, INSIDE.src, path))) found.push(`${INSIDE.readme} names src/${path}, which is gone. Fix its row.`);
  for (const entry of readdirSync(join(ROOT, INSIDE.src))) {
    if (!named.has(entry)) found.push(`src/${entry} has no row in the Inside table of ${INSIDE.readme}. Say what it holds.`);
  }
  return found.sort();
}

function managerBuilderBreaks({ tests }) {
  const count = tests.filter(({ file }) => /(?<![`'"])\bnew WorkflowManager\(/.test(readFileSync(file, "utf8"))).length;
  if (count > MANAGER_BUILDERS) return [`${count} test files build a WorkflowManager, over MANAGER_BUILDERS (${MANAGER_BUILDERS}). Go through runs/run.ts or the test kit.`];
  if (count < MANAGER_BUILDERS) return [`${count} test files build a WorkflowManager. Lower MANAGER_BUILDERS to ${count}.`];
  return [];
}

// ── The tests ───────────────────────────────────────────────────────────────────────────────────

const state = collect();
const now = {
  packages: packageBreaks(state),
  imports: importBreaks(state),
  cycles: cycleBreaks(state),
  homes: homeBreaks(state),
  reach: reachBreaks(state),
  exports: exportBreaks(state),
  contract: contractBreaks(),
  tests: testBreaks(state),
  scripts: scriptBreaks(state),
  sizes: sizeBreaks(lineCounts(state)),
  members: memberBreaks(),
  machine: machineBreaks(state),
  inside: insideBreaks(),
  managerBuilders: managerBuilderBreaks(state),
  ...unusedExportBreaks(state),
};

if (process.env.ARCH_PRINT) console.log(JSON.stringify(now, null, 2));

/** A listed break that is gone, or a new one, fails with what to change. */
function compareList(rule) {
  const known = new Set(BREAKS[rule]);
  const seen = new Set(now[rule]);
  const added = [...seen].filter((b) => !known.has(b));
  const gone = [...known].filter((b) => !seen.has(b));
  const lines = [];
  if (added.length) lines.push(`New breaks of the ${rule} rule. Move the code to where the tables say:\n  ${added.join("\n  ")}`);
  if (gone.length) lines.push(`Fixed, so remove them from BREAKS.${rule}:\n  ${gone.join("\n  ")}`);
  assert.equal(lines.join("\n"), "", lines.join("\n"));
}

test("only the table's packages exist, under our scope", () => compareList("packages"));
test("each package imports only what the table allows", () => compareList("imports"));
test("no source file imports itself at run time through others", () => compareList("cycles"));
test("only the files the table lists touch the machine", () => assert.equal(now.machine.join("\n"), "", now.machine.join("\n")));
test("each idea lives in its one home", () => compareList("homes"));
test("no file reaches at run time what the table keeps from it", () => compareList("reach"));
test("each package exports only what its caller imports", () => {
  const lines = [];
  for (const key of new Set([...Object.keys(BREAKS.exports), ...Object.keys(now.exports)])) {
    const was = BREAKS.exports[key] ?? 0;
    const is = now.exports[key] ?? 0;
    if (is > was) lines.push(`${key}: ${is}, more than the ${was} listed. Export only what the caller imports.`);
    if (is < was) lines.push(`${key}: ${is}, fewer than the ${was} listed. Lower BREAKS.exports.`);
  }
  assert.equal(lines.join("\n"), "", lines.join("\n"));
});
test("both adapters exist and pass one contract test", () => compareList("contract"));
test("each test file imports a run-time value of the code it tests", () => compareList("tests"));
test("each package runs its tests on a temporary home", () => compareList("scripts"));
test("each exported value has an importer", () => compareList("unused"));
test("each exported value has an importer in the source, not only in tests", () => compareList("forTests"));
test("each file and function stays under its line cap", () => assert.equal(now.sizes.join("\n"), "", now.sizes.join("\n")));
test("the engine README names each top-level file and folder of its src", () => assert.equal(now.inside.join("\n"), "", now.inside.join("\n")));
test("no more test files build a WorkflowManager themselves", () => assert.equal(now.managerBuilders.join("\n"), "", now.managerBuilders.join("\n")));
test("the manager's methods and the run's options stay at their caps", () => assert.equal(now.members.join("\n"), "", now.members.join("\n")));

test("each behavior change keeps the test that holds it", () => {
  assert.equal(PINS.length, 36, "docs/history/improve.md lists 36 behavior changes, and the table holds one row for each");
  const lines = [];
  const read = new Map();
  for (const { change, tests = [], waiting } of PINS) {
    if (!tests.length && !waiting) lines.push(`${change}: has no test and is not waiting for one`);
    for (const [file, title, needs] of tests) {
      if (!existsSync(join(ROOT, file))) {
        lines.push(`${change}: ${file} is gone`);
        continue;
      }
      if (!read.has(file)) read.set(file, { titles: runningTitles(join(ROOT, file)), text: readFileSync(join(ROOT, file), "utf8") });
      const { titles, text } = read.get(file);
      if (!titles.has(title)) lines.push(`${change}: "${title}" is no longer a test or a suite of ${file}`);
      else if (needs && !text.includes(needs)) lines.push(`${change}: ${file} no longer has the case ${needs}`);
    }
  }
  const message = `A behavior change lost its test. Keep the test's file and title, or move the pin in a commit of its own:\n  ${lines.join("\n  ")}`;
  assert.ok(lines.length === 0, message);
});
for (const { change, waiting } of PINS) {
  if (waiting) test(`a behavior change waits for its test: ${change}`, { todo: waiting });
}
