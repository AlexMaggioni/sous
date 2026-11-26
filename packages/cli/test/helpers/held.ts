// Runs whose steps the fake programs hold mid-turn, and the reads a test polls while they run.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HomePaths } from "@sous-run/engine";
import { testHome } from "@sous-run/engine/testing";
import { sous } from "../sous.js";

const FAKES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../test/fakes");

/** A test home whose fake programs follow `rules`, and the folder of their log, rules and gates. */
export function heldHome(workflows: Record<string, string>, rules: object[]): { paths: HomePaths; projectDir: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "sous-held-"));
  process.env.FAKE_LOG = join(dir, "fake.log");
  process.env.FAKE_RULES = join(dir, "rules.json");
  writeFileSync(process.env.FAKE_RULES, JSON.stringify(rules));
  const { paths, projectDir } = testHome(workflows, { claudePath: join(FAKES, "claude"), codexPath: join(FAKES, "codex") });
  return { paths, projectDir, dir };
}

/** The JSON object sous printed. */
export function json(printed: { code: number; out: string }): Record<string, any> {
  let parsed: unknown;
  assert.doesNotThrow(() => (parsed = JSON.parse(printed.out)), `sous printed no JSON object (exit ${printed.code}):\n${printed.out}`);
  return parsed as Record<string, any>;
}

/** Poll an async read until it holds, or 20 seconds pass. */
export async function until(ready: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await ready()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** What `sous step` prints for the step, or nothing before the step has started. */
export async function stepView(paths: HomePaths, runId: string, label: string): Promise<{ status?: string; activity?: Array<{ kind: string }> } | undefined> {
  const printed = await sous(paths, ["step", runId, label, "--json"], { env: {} });
  return printed.code === 0 ? JSON.parse(printed.out) : undefined;
}

/** Whether the step runs and its activity shows a tool call, so its turn has reported the
 *  tokens of the tool call's message. */
export async function inToolCall(paths: HomePaths, runId: string, label: string): Promise<boolean> {
  const view = await stepView(paths, runId, label);
  return view?.status === "running" && (view.activity ?? []).some((line) => line.kind === "tool");
}

/** Whether an agent of the step still holds one of the machine's agent slots. Its runner gives
 *  the slot back last, once the program has ended. */
export function holdsSlot(paths: HomePaths, label: string): boolean {
  if (!existsSync(paths.slots)) return false;
  return readdirSync(paths.slots).some((name) => {
    try {
      return (JSON.parse(readFileSync(join(paths.slots, name), "utf8")) as { label?: unknown }).label === label;
    } catch {
      // A slot file being written or removed.
      return false;
    }
  });
}
