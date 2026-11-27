// The steps module on the fake programs in test/fakes: a folder with the fakes' log and rules,
// the options that point the module at the fakes, and a routed request.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Account } from "@sous-run/harnesses";
import type { StepRequest } from "../../src/steps/agent-run.js";
import type { StepAsk } from "../../src/steps/agent-runner.js";
import type { createSteps, StepsOptions } from "../../src/steps/steps.js";

const FAKES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../test/fakes");

/** One turn line of the fakes' request log. */
export interface FakeLine {
  program: string;
  /** The program's process id. Turns with the same pid ran in one program. */
  pid: number;
  sessionId: string;
  resume: boolean;
  schema: unknown;
  /** The schema the prompt asked the answer to fit in its text, in a Claude Code program with none. */
  textSchema?: unknown;
  prompt: string;
  /** The text blocks or items of the user message, when it had more than one. */
  texts?: string[];
  appendSystemPrompt?: string | null;
  developerInstructions?: string | null;
}

export type FakePlace = ReturnType<typeof fakePlace>;

/** The ask the claude adapter puts after a prompt whose value comes as JSON in its text. */
const IN_TEXT = "\n\nAnswer with one JSON object that fits this JSON schema, and nothing else:\n";

/** The schema a turn answered to: its program's, or the one its prompt asked for in its text. */
export const askedSchema = (line: FakeLine | undefined): unknown => line?.schema ?? line?.textSchema ?? null;

/** A turn's prompt without the ask for JSON in its text. */
export const promptOf = (line: FakeLine | undefined): string | undefined => (line?.textSchema ? line.prompt.slice(0, line.prompt.lastIndexOf(IN_TEXT)) : line?.prompt);

/**
 * How a later turn went on in an earlier turn's session: "held" in the earlier turn's program,
 * "resumed" in a new program that resumed the session, else "apart".
 */
export function wentOn(earlier: Pick<FakeLine, "pid" | "sessionId"> | undefined, later: Pick<FakeLine, "pid" | "sessionId" | "resume"> | undefined): "held" | "resumed" | "apart" {
  if (!earlier || !later || later.sessionId !== earlier.sessionId) return "apart";
  if (later.pid === earlier.pid) return "held";
  return later.resume ? "resumed" : "apart";
}

/** A folder with the fakes' log and rules, a project and an account folder per program. */
export function fakePlace(rules: object[] = []) {
  delete process.env.FAKE_VERSION;
  const dir = mkdtempSync(join(tmpdir(), "engine-fake-steps-"));
  const cwd = join(dir, "project");
  mkdirSync(cwd);
  const accounts: Record<"claude" | "codex", Account> = { claude: { folder: join(dir, "claude-home") }, codex: { folder: join(dir, "codex-home") } };
  for (const account of Object.values(accounts)) mkdirSync(account.folder!);
  const log = join(dir, "fake.log");
  const rulesFile = join(dir, "rules.json");
  writeFileSync(rulesFile, JSON.stringify(rules));
  // The adapters pass the caller's environment on, so the fakes read these.
  process.env.FAKE_LOG = log;
  process.env.FAKE_RULES = rulesFile;
  return {
    dir,
    cwd,
    accounts,
    /** Open the gate a rule's hold waits on. */
    gate: (name: string) => writeFileSync(join(dir, name), ""),
    /** The turn lines, in order. Lines for goals, tells and asks are left out. */
    lines: () =>
      (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as FakeLine & { outcome?: string }) : []).filter(
        (line) => line.outcome !== undefined,
      ),
  };
}

/** Puts a skill of this name in the place's project, where Codex's skills/list finds it. */
export function plantSkill(place: Pick<FakePlace, "cwd">, name: string): void {
  const folder = join(place.cwd, ".agents", "skills", name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} skill.\n---\nSay ${name.toUpperCase()}.\n`);
}

/**
 * The text a program gets for a prompt that starts with a skill's command. Claude Code reads the
 * command as written. Codex reads no slash command from text, so its adapter sends the skill's $
 * name, with the skill as an item of its own.
 */
export const said = (program: "claude" | "codex", prompt: string): string => (program === "codex" && prompt.startsWith("/") ? `$${prompt.slice(1)}` : prompt);

/** The steps options that run each harness on its fake program. */
export const onFakes = (place: FakePlace, extra: Partial<StepsOptions> = {}): StepsOptions => ({
  cwd: place.cwd,
  programs: (harness) => ({ path: join(FAKES, harness), env: {} }),
  accounts: place.accounts,
  ...extra,
});

/** The request the engine sends: it asks the steps module for the step's route first. */
export function routed(steps: ReturnType<typeof createSteps>, ask: StepAsk, fields: Omit<StepRequest, "route"> = {}): StepRequest {
  const route = steps.route(ask);
  return { label: ask.label, ...fields, ...(route.requested === undefined ? {} : { model: route.requested }), route };
}

/** The system text a fake's session got: the appended system prompt, or developerInstructions. */
export const systemOf = (line: FakeLine | undefined) => line?.appendSystemPrompt ?? line?.developerInstructions ?? undefined;
