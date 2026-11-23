// The account orc's steps use. orc is logged in on one account per program, and `default` is the
// program's own login. `orc account add` keeps a Claude Code login token, made with
// `claude setup-token`, in accounts.json, which only the user can read. Each run records its
// account and keeps it when it pauses and resumes, also when the service resumes it. A run that an
// agent starts uses that agent's account. `orc account use` moves the runs waiting at a usage limit
// to the new account and resumes them, through run.ts. Codex steps use Codex's own login for now.

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import type { Account, HarnessId } from "@orchestrator/harnesses";
import { HARNESSES, harnessName, isHarness, loginOf } from "./agents.js";
import { readStrictJsonFile, writeJsonFile } from "./json-file.js";
import type { HomePaths } from "./runs/home.js";
import { loadRecord, updateRecord, type RunAccount, type RunRecord } from "./runs/records.js";

/** The program's own login. */
export const DEFAULT = "default";
/** The account of the agent's session that started the run. */
export const CALLER = "caller";

export interface Login {
  token: string;
  addedAt: string;
}

interface AccountsFile {
  /** The account orc uses for new runs, by program. Missing means default. */
  current?: Partial<Record<HarnessId, string>>;
  logins?: Partial<Record<HarnessId, Record<string, Login>>>;
  /** Tokens that runs started with and that are no account of orc's, such as an agent's own, by key. */
  kept?: Record<string, string>;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface AccountName {
  program: HarnessId;
  name: string;
}

/** "work" is a Claude Code account, "codex/work" a Codex one. "claude/work" works too. */
export function parseAccountName(text: string | undefined): AccountName {
  if (!text) throw new Error("give an account name, such as work");
  const slash = text.indexOf("/");
  const program = slash === -1 ? "claude" : text.slice(0, slash);
  const name = slash === -1 ? text : text.slice(slash + 1);
  if (!isHarness(program)) throw new Error(`"${program}" is no program. Use a bare name for Claude Code, or codex/<name>.`);
  if (!NAME.test(name)) throw new Error(`"${name}" is not a usable name. Use letters, digits, dots, dashes and underscores.`);
  return { program, name };
}

/** How the account reads in orc's output: a bare name for Claude Code, codex/<name> for Codex. */
export function accountLabel(program: HarnessId, name: string): string {
  return program === "claude" ? name : `${program}/${name}`;
}

function readFile(paths: HomePaths): AccountsFile {
  return readStrictJsonFile<AccountsFile>(paths.accounts, {});
}

function writeFile(paths: HomePaths, file: AccountsFile): void {
  mkdirSync(paths.home, { recursive: true });
  writeJsonFile(paths.accounts, file, 0o600);
}

const keyOf = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 16);

export interface AccountRow {
  program: HarnessId;
  name: string;
  current: boolean;
  addedAt?: string;
}

/** Each program's accounts, default first. Tokens stay out. */
export function listAccounts(paths: HomePaths): AccountRow[] {
  const file = readFile(paths);
  const rows: AccountRow[] = [];
  for (const program of HARNESSES) {
    const current = currentAccount(paths, program, file);
    rows.push({ program, name: DEFAULT, current: current === DEFAULT });
    for (const [name, login] of Object.entries(file.logins?.[program] ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      rows.push({ program, name, current: current === name, addedAt: login.addedAt });
    }
  }
  return rows;
}

/** The account orc uses for the program's new runs. */
export function currentAccount(paths: HomePaths, program: HarnessId, file = readFile(paths)): string {
  const name = file.current?.[program];
  return name && file.logins?.[program]?.[name] ? name : DEFAULT;
}

/** Check a name for a new account, before the login is made. */
export function checkNewAccount(paths: HomePaths, spec: string, file = readFile(paths)): AccountName {
  const { program, name } = parseAccountName(spec);
  if (program !== "claude") {
    throw new Error(`Codex accounts come later. Codex steps use Codex's own login, from ${loginOf("codex").variable} where orc starts.`);
  }
  if (name === DEFAULT || name === CALLER) throw new Error(`"${name}" is taken by orc. Pick another name.`);
  if (file.logins?.[program]?.[name]) throw new Error(`there is an account ${name} already. orc account remove ${name} first.`);
  return { program, name };
}

export function addAccount(paths: HomePaths, spec: string, token: string): AccountName {
  const file = readFile(paths);
  const { program, name } = checkNewAccount(paths, spec, file);
  const value = token.trim();
  if (!/^sk-ant-oat[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("that is not a Claude Code login token. claude setup-token prints one that starts with sk-ant-oat.");
  }
  const same = Object.entries(file.logins?.[program] ?? {}).find(([, login]) => login.token === value);
  if (same) throw new Error(`account ${same[0]} has this token already.`);
  file.logins = { ...file.logins, [program]: { ...file.logins?.[program], [name]: { token: value, addedAt: new Date().toISOString() } } };
  writeFile(paths, file);
  return { program, name };
}

/** Forget a login. Refused while one of the unfinished runs given uses it. run.ts's removeAccount
 *  finds those runs. */
export function deleteAccount(paths: HomePaths, spec: string, unfinished: readonly RunRecord[]): AccountName {
  const { program, name } = parseAccountName(spec);
  const file = readFile(paths);
  if (!file.logins?.[program]?.[name]) throw new Error(`no account ${accountLabel(program, name)}. orc account lists them.`);
  const using = unfinished.filter((record) => record.accounts?.[program]?.name === name);
  if (using.length) {
    throw new Error(
      `${using.map((record) => record.runId).join(", ")} ${using.length === 1 ? "uses" : "use"} account ${accountLabel(program, name)}. ` +
        `orc account use <name> moves the runs waiting at the limit to another account. Stop or finish the others first.`,
    );
  }
  const { [name]: _gone, ...rest } = file.logins[program]!;
  file.logins = { ...file.logins, [program]: rest };
  if (file.current?.[program] === name) delete file.current[program];
  writeFile(paths, file);
  return { program, name };
}

/** Make the account orc's current one for its program. run.ts's useAccount then moves the runs
 *  waiting at the limit. */
export function setCurrentAccount(paths: HomePaths, spec: string): AccountName {
  const { program, name } = parseAccountName(spec);
  const file = readFile(paths);
  if (name !== DEFAULT && !file.logins?.[program]?.[name]) {
    throw new Error(`no account ${accountLabel(program, name)}. orc account lists them, and orc account add ${accountLabel(program, name)} adds it.`);
  }
  file.current = { ...file.current, [program]: name };
  if (name === DEFAULT) delete file.current[program];
  writeFile(paths, file);
  return { program, name };
}

/** Give a run another login for a program. The run keeps its settings folder. */
export function moveRunAccount(paths: HomePaths, runId: string, program: HarnessId, name: string): void {
  const record = loadRecord(paths, runId);
  if (!record) return;
  const before = record.accounts?.[program];
  const folder = before?.folder !== undefined ? before.folder : (loginOf(program).value ?? null);
  updateRecord(paths, runId, { accounts: { ...record.accounts, [program]: { name, folder } } });
}

/**
 * The accounts a new run records. A run an agent of another run starts takes that run's accounts.
 * A run a Claude Code session starts uses that session's login for its Claude Code steps. Any
 * other run uses orc's current account. A login token in the environment that is no account of
 * orc's is kept, so a resume by the service uses it too.
 */
export function accountsForRun(
  paths: HomePaths,
  env: Record<string, string | undefined>,
  options: { caller?: boolean; parentRunId?: string } = {},
): Record<HarnessId, RunAccount> {
  const parent = options.parentRunId ? loadRecord(paths, options.parentRunId) : undefined;
  if (parent?.accounts?.claude && parent.accounts.codex) return { claude: parent.accounts.claude, codex: parent.accounts.codex };
  const file = readFile(paths);
  const folder = (program: HarnessId) => loginOf(program, env).value ?? null;
  const fromEnv = (name: string): RunAccount => {
    const token = loginOf("claude", env).token;
    if (!token) return { name, folder: folder("claude") };
    const named = Object.entries(file.logins?.claude ?? {}).find(([, login]) => login.token === token)?.[0];
    if (named) return { name: named, folder: folder("claude") };
    const key = keyOf(token);
    if (file.kept?.[key] !== token) {
      file.kept = { ...file.kept, [key]: token };
      writeFile(paths, file);
    }
    return { name, folder: folder("claude"), kept: key };
  };
  const current = currentAccount(paths, "claude", file);
  const claude = options.caller ? fromEnv(CALLER) : current === DEFAULT ? fromEnv(DEFAULT) : { name: current, folder: folder("claude") };
  return { claude, codex: { name: DEFAULT, folder: folder("codex") } };
}

/** Who a step on the program runs as. Throws when the run's login is gone. */
export function stepAccount(paths: HomePaths, program: HarnessId, account: RunAccount): Account {
  // Undefined removes the variable, so the program uses its usual folder.
  const folder = account.folder ?? undefined;
  if (program !== "claude") return { folder };
  const file = readFile(paths);
  if (account.name !== DEFAULT && account.name !== CALLER) {
    const login = file.logins?.claude?.[account.name];
    if (!login) throw new Error(`the run uses Claude Code account ${account.name}, which orc no longer has. orc account add ${account.name} adds it again.`);
    return { folder, token: login.token, named: true };
  }
  const kept = account.kept ? file.kept?.[account.kept] : undefined;
  if (account.kept && !kept) throw new Error(`the login token this run started with is gone from ${paths.accounts}.`);
  return { folder, token: kept };
}

/** Each program's account for the run's steps. A run from before accounts has none, and its steps keep the caller's login. */
export function runAccounts(paths: HomePaths, accounts: RunRecord["accounts"]): Partial<Record<HarnessId, Account>> {
  const result: Partial<Record<HarnessId, Account>> = {};
  for (const program of HARNESSES) {
    const account = accounts?.[program];
    if (account) result[program] = stepAccount(paths, program, account);
  }
  return result;
}

const tilde = (path: string) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);

/** The folder a program uses for a run: the recorded one, else its usual folder. */
export function folderText(program: HarnessId, folder: string | null | undefined): string {
  if (folder) return tilde(folder.replace(/^~(?=$|\/)/, homedir()));
  return tilde(loginOf(program, {}).folder);
}

/** One account in a sentence, such as "work" or "default, Claude Code's own login in ~/.claude". */
export function describeAccount(program: HarnessId, account: RunAccount | undefined): string {
  const name = account?.name ?? DEFAULT;
  const where = folderText(program, account?.folder);
  if (name === DEFAULT) return `default, ${harnessName(program)}'s own login in ${where}`;
  if (name === CALLER) return `the login of the agent that started it, in ${where}`;
  return name;
}

/** When the limit resets, such as "14:00", or "Sat 09:30" when it is more than 20 hours away. */
export function resetText(at: Date | undefined, now = new Date()): string | undefined {
  if (!at || Number.isNaN(at.getTime())) return undefined;
  const time = at.toTimeString().slice(0, 5);
  return at.getTime() - now.getTime() > 20 * 3600_000 ? `${at.toLocaleDateString("en", { weekday: "short" })} ${time}` : time;
}

/** What the user reads when a run waits at the limit: whose limit, when it resets, how to go on
 *  now. The reset time is the one the pause rule gives. */
export function limitNotice(paths: HomePaths, record: RunRecord, resetAt: Date | undefined): string {
  const program = record.limit?.program ?? "claude";
  const name = record.limit?.account ?? record.accounts?.[program]?.name ?? DEFAULT;
  const what = harnessName(program);
  const who = name === CALLER ? `The agent's ${what} login` : name === DEFAULT ? `${what}'s own login (default)` : `${what} account ${name}`;
  const reset = resetText(resetAt);
  const current = currentAccount(paths, program);
  const now = current !== name ? `orc account use ${accountLabel(program, current)} moves it to the account orc uses now.` : `orc account use <name> goes on now on another account.`;
  return `${who} hit its usage limit.${reset ? ` It resets at ${reset}.` : ""} ${now}`;
}
