// One case against the fake programs in test/fakes: a folder of its own with the fake's log and
// rules, a project and an account folder.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessId, Step } from "../../src/index.js";

const FAKES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../test/fakes");

/** One line of the fake's request log. */
export interface LogLine {
  prompt: string;
  texts?: string[];
  images?: unknown[];
  rule?: number | null;
}

/** The folder a test file's cases go in, under a temporary HOME when the file has none. */
export function caseRoot(name: string): string {
  if (!process.env.HOME || process.env.HOME === userInfo().homedir || !existsSync(process.env.HOME)) process.env.HOME = mkdtempSync(join(tmpdir(), `harness-${name}-home-`));
  delete process.env.FAKE_VERSION;
  return mkdtempSync(join(process.env.HOME, `${name}-`));
}

/** A case whose fake answers by rules. It points FAKE_LOG and FAKE_RULES at its own files. The test builds the harness from `options`. */
export function fakeCase(root: string, id: HarnessId, rules: object[] = []) {
  const dir = mkdtempSync(join(root, `${id}-`));
  const cwd = join(dir, "project");
  mkdirSync(cwd);
  mkdirSync(join(dir, "account"));
  const log = join(dir, "fake.log");
  const rulesFile = join(dir, "rules.json");
  writeFileSync(rulesFile, JSON.stringify(rules));
  process.env.FAKE_LOG = log;
  process.env.FAKE_RULES = rulesFile;
  return {
    dir,
    options: { path: join(FAKES, id), env: {} },
    /** The step with the case's project and account. */
    step: (fields: Partial<Step> & { prompt: string }): Step => ({ cwd, account: { folder: join(dir, "account") }, ...fields }),
    lines: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogLine) : []),
  };
}
