import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { WORKFLOW_PROJECTS_SUBDIR, workflowProjectKey, workflowProjectPaths } from "../src/runs/persistence/project-paths.js";
import { WORKFLOW_HOME_RELATIVE_DIR, workflowHomeDir } from "../src/workflow-paths.js";
import { withFakeHome } from "./helpers/fake-home.js";

function withIsolatedHome(fn: (home: string, cwd: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "ap-dw-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "ap-dw-project-"));
  try {
    withFakeHome(home, () => fn(home, cwd));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("workflow paths", () => {
  it("resolves workflow home under the user home", () => {
    withIsolatedHome((home) => {
      assert.equal(workflowHomeDir(), join(home, WORKFLOW_HOME_RELATIVE_DIR));
    });
  });

  it("creates stable project namespaces from cwd", () => {
    withIsolatedHome((_home, cwd) => {
      const key = workflowProjectKey(cwd);
      assert.equal(key, workflowProjectKey(cwd));
      assert.match(key, /^[a-z0-9._-]+-[a-f0-9]{12}$/);
      assert.ok(key.startsWith(basename(cwd).toLowerCase()));
    });
  });

  it("keeps project storage under workflow home", () => {
    withIsolatedHome((home, cwd) => {
      const paths = workflowProjectPaths(cwd);
      assert.ok(paths.rootDir.startsWith(join(home, WORKFLOW_HOME_RELATIVE_DIR, WORKFLOW_PROJECTS_SUBDIR)));
      assert.equal(paths.runsDir, join(paths.rootDir, "runs"));
      assert.equal(paths.savedDir, join(paths.rootDir, "saved"));
      assert.equal(paths.settingsPath, join(paths.rootDir, "settings.json"));
    });
  });

  it("uses an explicit absolute persistence root before the homedir default", () => {
    withIsolatedHome((_home, cwd) => {
      const explicitRoot = mkdtempSync(join(tmpdir(), "ap-dw-root-explicit-"));
      try {
        const paths = workflowProjectPaths(cwd, { persistenceRoot: explicitRoot });
        assert.ok(paths.rootDir.startsWith(join(explicitRoot, WORKFLOW_PROJECTS_SUBDIR)));
        assert.equal(workflowHomeDir({ persistenceRoot: explicitRoot }), explicitRoot);
      } finally {
        rmSync(explicitRoot, { recursive: true, force: true });
      }
    });
  });

  it("rejects a relative persistence root", () => {
    withIsolatedHome((_home, cwd) => {
      assert.throws(() => workflowProjectPaths(cwd, { persistenceRoot: "relative-root" }), /persistenceRoot.*absolute/);
    });
  });
});
