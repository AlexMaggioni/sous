// The Codex adapter. It speaks to `codex app-server` over JSON-RPC.

import { StepFailure } from "../failure.js";
import { findProgram } from "../lookup.js";
import type { Account, FindOptions, Found, Harness, Step, StepEvents } from "../types.js";
import type { ModelListResponse } from "./generated/v2/ModelListResponse.js";
import { CODEX, codexEnv, codexLogin, codexPlaces, codexVersion } from "./program.js";
import { openServer, runCodex } from "./run.js";

export function createCodexHarness(lookup: FindOptions = {}): Harness {
  const find = (): Found => findProgram(CODEX, lookup);

  /** The program's path, or the failure that says why the step cannot run. */
  async function ready(): Promise<string> {
    const found = find();
    if ("problem" in found) throw new StepFailure(found.problem, { kind: "program", problem: found.problem });
    const { problem } = await codexVersion(found.path);
    if (problem) throw new StepFailure(problem, { kind: "program", problem });
    return found.path;
  }

  return {
    id: "codex",
    find,
    async version(path?: string) {
      const where = path ?? find();
      if (typeof where !== "string" && "problem" in where) return { problem: where.problem };
      return codexVersion(typeof where === "string" ? where : where.path);
    },
    async models(account?: Account) {
      const server = await openServer(await ready(), codexEnv(account));
      try {
        const models: string[] = [];
        let cursor: string | null = null;
        do {
          const page: ModelListResponse = await server.request("model/list", { cursor, includeHidden: false });
          models.push(...page.data.map((row) => row.model));
          cursor = page.nextCursor;
        } while (cursor);
        return models;
      } finally {
        server.close();
      }
    },
    async run(step: Step, events?: StepEvents) {
      return runCodex(await ready(), step, events);
    },
    login: codexLogin,
    places: codexPlaces,
    env: codexEnv,
  };
}
