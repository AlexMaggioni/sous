// What `sous doctor` checks, on the fake programs in test/fakes: the live step runs the model it
// was asked for.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkPrograms } from "../src/programs.js";
import { homePaths, loadConfig } from "../src/runs/home.js";

const FAKES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../test/fakes");
delete process.env.FAKE_VERSION;
for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) delete process.env[name];

/** A sous home whose config points at the fakes, and the fakes' request log. */
function fakeHome() {
  const dir = mkdtempSync(join(tmpdir(), "engine-programs-"));
  const paths = homePaths(join(dir, "sous"));
  const log = join(dir, "fake.log");
  const rules = join(dir, "rules.json");
  writeFileSync(rules, "[]");
  process.env.FAKE_LOG = log;
  process.env.FAKE_RULES = rules;
  const config = { ...loadConfig(paths), claudePath: join(FAKES, "claude"), codexPath: join(FAKES, "codex") };
  const models = () =>
    (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []).map((line) => JSON.parse(line) as { program: string; model: string | null });
  return { paths, config, models };
}

describe("checkPrograms --live", () => {
  it("runs a bare model name on the harness it routes to, and says so", async () => {
    const home = fakeHome();
    const reports = await checkPrograms(home.paths, home.config, { live: true, model: "haiku" });
    assert.deepEqual(home.models(), [{ ...home.models()[0], program: "claude", model: "haiku" }]);
    const claude = reports.find((report) => report.program === "claude")!;
    assert.equal(claude.live?.model, "haiku");
    assert.equal(claude.live?.error, undefined);
    assert.equal(reports.find((report) => report.program === "codex")!.live, undefined);
  });

  it("runs a model that names its harness without the harness", async () => {
    const home = fakeHome();
    await checkPrograms(home.paths, home.config, { live: true, model: "codex/gpt-6.1-sol" });
    assert.deepEqual(
      home.models().map(({ program, model }) => ({ program, model })),
      [{ program: "codex", model: "gpt-6.1-sol" }],
    );
  });

  it("runs each program's own default model when no model is asked", async () => {
    const home = fakeHome();
    const reports = await checkPrograms(home.paths, home.config, { live: true });
    // The fake Codex names its own default model in the log, so only Claude's line shows none was sent.
    assert.deepEqual(
      home.models().map(({ program }) => program),
      ["claude", "codex"],
    );
    assert.equal(home.models()[0]!.model, null);
    assert.deepEqual(
      reports.map((report) => report.live?.model.split("/")[0]),
      ["claude", "codex"],
    );
  });
});
