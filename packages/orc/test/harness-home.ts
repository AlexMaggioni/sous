// The agent lookup reads the harnesses' home folders. A test imports this file first, for its
// effect: it points the lookup at empty folders, so no test reads the person's logins.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const harnessHome = mkdtempSync(join(tmpdir(), "orc-harness-home-"));
process.env.CLAUDE_CONFIG_DIR = join(harnessHome, ".claude");
process.env.CODEX_HOME = join(harnessHome, ".codex");
process.env.XDG_CONFIG_HOME = join(harnessHome, ".config");
delete process.env.AGENTPRISM_DEFAULT_BACKEND;
