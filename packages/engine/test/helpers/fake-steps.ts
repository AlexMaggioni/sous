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
  sessionId: string;
  resume: boolean;
  schema: unknown;
  prompt: string;
  /** The text blocks or items of the user message, when it had more than one. */
  texts?: string[];
  appendSystemPrompt?: string | null;
  developerInstructions?: string | null;
}

export type FakePlace = ReturnType<typeof fakePlace>;

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
    /** The turn lines, in order. Lines for goals, tells and asks are left out. */
    lines: () =>
      (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as FakeLine & { outcome?: string }) : []).filter(
        (line) => line.outcome !== undefined,
      ),
  };
}

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
