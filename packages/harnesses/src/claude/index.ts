// The Claude Code adapter.

import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { StepFailure } from "../failure.js";
import { findProgram } from "../lookup.js";
import type { Account, FindOptions, Found, Harness, Step, StepEvents } from "../types.js";
import { CLAUDE, claudeEnv, claudeLogin, claudePlaces, claudeVersion } from "./program.js";
import { Held } from "../held.js";
import { runClaude, type ClaudeProgram } from "./run.js";

export function createClaudeHarness(lookup: FindOptions = {}): Harness {
  const find = (): Found => findProgram(CLAUDE, lookup);
  const held = new Held<ClaudeProgram>();

  /** The program's path, or the failure that says why the step cannot run. */
  async function ready(): Promise<string> {
    const found = find();
    if ("problem" in found) throw new StepFailure(found.problem, { kind: "program", problem: found.problem });
    const { problem } = await claudeVersion(found.path);
    if (problem) throw new StepFailure(problem, { kind: "program", problem });
    return found.path;
  }

  return {
    id: "claude",
    find,
    async version(path?: string) {
      const where = path ?? find();
      if (typeof where !== "string" && "problem" in where) return { problem: where.problem };
      return claudeVersion(typeof where === "string" ? where : where.path);
    },
    async models(account?: Account) {
      const path = await ready();
      // supportedModels() reads the initialize answer, so the prompt never sends a message.
      let release!: () => void;
      const never = new Promise<void>((resolve) => (release = resolve));
      async function* prompt(): AsyncGenerator<SDKUserMessage> {
        await never;
      }
      const q = query({ prompt: prompt(), options: { pathToClaudeCodeExecutable: path, env: claudeEnv(account), settingSources: ["user", "project", "local"] } });
      try {
        return (await q.supportedModels()).map((row) => row.value);
      } finally {
        release();
        q.close();
      }
    },
    async run(step: Step, events?: StepEvents) {
      return runClaude(await ready(), step, events ?? {}, held);
    },
    release: (sessionId?: string) => held.release(sessionId),
    login: claudeLogin,
    places: claudePlaces,
    env: claudeEnv,
  };
}
