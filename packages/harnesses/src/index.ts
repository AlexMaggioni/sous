// The harness adapters. Each one runs a step on one coding agent program.

import { createClaudeHarness } from "./claude/index.js";
import { createCodexHarness } from "./codex/index.js";
import type { FindOptions, Harness, HarnessId } from "./types.js";

export type * from "./types.js";

const ADAPTERS: Record<HarnessId, (lookup: FindOptions) => Harness> = { claude: createClaudeHarness, codex: createCodexHarness };

/** The adapter for one program. lookup says where to look for the program first. */
export function createHarness(id: HarnessId, lookup: FindOptions = {}): Harness {
  return ADAPTERS[id](lookup);
}
