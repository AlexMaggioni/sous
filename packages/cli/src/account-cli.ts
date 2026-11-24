// `sous account`: list the accounts, add a Claude Code login, switch, and remove one.

import { spawnSync } from "node:child_process";
import {
  accountLabel,
  addAccount,
  checkNewAccount,
  currentAccount,
  ensureHome,
  folderText,
  HARNESSES,
  harnessName,
  homePaths,
  listAccounts,
  loadConfig,
  loadRecord,
  loginOf,
  removeAccount,
  setupTokenProgram,
  useAccount,
  waitingRuns,
  type HomePaths,
  type Launcher,
} from "@sous/engine";
import { print, reply } from "./reply.js";

export interface AccountCommandOptions {
  json?: boolean;
  /** Makes the error for a wrong command line, which exits with 64. */
  usage?: (message: string) => Error;
  /** Reads the token. Default: hidden input in a terminal, else all of stdin. */
  readToken?: () => Promise<string>;
  /** Runs `claude setup-token`. Default: in this terminal, when stdin is one. */
  setupToken?: (paths: HomePaths) => void;
  out?: (line: string) => void;
  /** Starts the workers of the runs `sous account use` moves. */
  launch?: Launcher;
}

/** Read a line without showing it. Pasted text works. */
async function readHidden(prompt: string): Promise<string> {
  const input = process.stdin;
  process.stderr.write(prompt);
  input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (error?: Error) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      // A terminal may wrap pasted text in bracketed paste marks.
      else resolve(value.replace(/\[20[01]~/g, ""));
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return done();
        if (char === "\u0003" || char === "\u0004") return done(new Error("cancelled, nothing added"));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    input.on("data", onData);
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

function runSetupToken(paths: HomePaths): void {
  const found = setupTokenProgram(loadConfig(paths));
  if ("problem" in found) throw new Error(found.problem);
  const ran = spawnSync(found.path, ["setup-token"], { stdio: "inherit", env: found.env });
  if (ran.error) throw new Error(`claude setup-token did not start: ${ran.error.message}`);
  if (ran.status !== 0) throw new Error(`claude setup-token stopped with exit ${ran.status ?? ran.signal}. Nothing was added.`);
}

function launcher(options: AccountCommandOptions): Launcher {
  return (
    options.launch ??
    (() => {
      throw new Error("sous account use needs a launcher to start the workers of the runs it moves");
    })
  );
}

export async function cmdAccount(positionals: string[], options: AccountCommandOptions = {}): Promise<number> {
  const paths = ensureHome(homePaths());
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const usage = options.usage ?? ((message: string) => new Error(message));
  const [action, spec, ...extra] = positionals;
  if (extra.length) throw usage(`sous account ${action} takes one name. Extra words: ${extra.join(" ")}`);
  const needName = () => {
    if (!spec) throw usage(`sous account ${action} <name>`);
    return spec;
  };

  switch (action) {
    case undefined:
    case "list":
      return listCommand(paths, out, options.json === true);
    case "add": {
      // Check the name before the browser login, so a wrong one costs nothing.
      const { name } = checkNewAccount(paths, needName());
      const terminal = process.stdin.isTTY === true;
      if (options.setupToken ?? terminal) {
        out("Claude Code opens a login in the browser. Log in with the account to add.");
        (options.setupToken ?? runSetupToken)(paths);
      }
      const token = await (options.readToken ?? (terminal ? () => readHidden("Paste the token it printed (it stays hidden): ") : readStdin))();
      addAccount(paths, needName(), token);
      out(`added Claude Code account ${name}. sous account use ${name} makes sous use it.`);
      return 0;
    }
    case "use": {
      const result = useAccount(paths, needName(), launcher(options));
      const label = accountLabel(result.program, result.name);
      out(`sous uses ${harnessName(result.program)} account ${label} for new runs.`);
      for (const run of result.moved) out(`resumed ${run.runId}  ${run.workflow}  on ${label}, was waiting at the limit of ${run.from}`);
      for (const run of result.same) out(`${run.runId}  ${run.workflow}  waits at the limit of ${label} itself, and goes on after the reset`);
      return 0;
    }
    case "remove":
    case "rm": {
      const { program, name } = removeAccount(paths, needName());
      out(`removed ${harnessName(program)} account ${accountLabel(program, name)}.${currentAccount(paths, program) === "default" ? " sous uses default." : ""}`);
      return 0;
    }
    default:
      throw usage(`sous account [add|use|remove <name>], got "${action}"`);
  }
}

function listCommand(paths: HomePaths, out: (line: string) => void, json: boolean): number {
  const rows = listAccounts(paths);
  const waiting = waitingRuns(paths);
  if (json) return print(reply({ accounts: rows, waiting: waiting.map((run) => ({ runId: run.runId, workflow: run.workflow, limit: run.limit })) }), true, out);
  const width = Math.max(...rows.map((row) => accountLabel(row.program, row.name).length)) + 2;
  for (const program of HARNESSES) {
    out(harnessName(program));
    for (const row of rows.filter((entry) => entry.program === program)) {
      const what = row.name === "default" ? `${harnessName(program)}'s own login, in ${folderText(program, loginOf(program).value)}` : `login token, added ${row.addedAt?.slice(0, 10)}`;
      out(`${row.current ? "*" : " "} ${accountLabel(program, row.name).padEnd(width)}${what}`);
    }
  }
  if (process.env.SOUS_RUN_ID) {
    const parent = loadRecord(paths, process.env.SOUS_RUN_ID);
    out(`\nThis shell is in run ${process.env.SOUS_RUN_ID}${parent?.accounts?.claude ? `, on ${parent.accounts.claude.name}` : ""}. A run started here uses that run's accounts.`);
  } else if (process.env.CLAUDECODE === "1") {
    out("\nThis shell is a Claude Code session. A run started here uses that session's login for its Claude Code steps.");
  }
  if (waiting.length) {
    out("\nWaiting at the usage limit:");
    for (const run of waiting) out(`  ${run.runId}  ${run.workflow}  on ${accountLabel(run.program, run.account)}`);
    out("sous account use <name> moves them to another account and resumes them now.");
  }
  return 0;
}
