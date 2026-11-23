import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { WORKFLOW_PROJECTS_SUBDIR, workflowProjectKey, workflowProjectPaths } from "../src/runs/persistence/project-paths.js";
import { ORCHESTRATOR_PERSISTENCE_ROOT_ENV, WORKFLOW_HOME_RELATIVE_DIR, workflowHomeDir } from "../src/workflow-paths.js";
import { withFakeHome } from "./helpers/fake-home.js";

function withIsolatedHome(fn: (home: string, cwd: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "ap-dw-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "ap-dw-project-"));
  const priorRoot = process.env[ORCHESTRATOR_PERSISTENCE_ROOT_ENV];
  try {
    delete process.env[ORCHESTRATOR_PERSISTENCE_ROOT_ENV];
    withFakeHome(home, () => fn(home, cwd));
  } finally {
    if (priorRoot === undefined) delete process.env[ORCHESTRATOR_PERSISTENCE_ROOT_ENV];
    else process.env[ORCHESTRATOR_PERSISTENCE_ROOT_ENV] = priorRoot;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("workflow paths", () => {
  it("anchors the workflow home under .orchestrator/engine", () => {
    // The home-relative dir is ".orchestrator/engine".
    assert.equal(WORKFLOW_HOME_RELATIVE_DIR, ".orchestrator/engine");
  });

  it("resolves workflow home under the user home", () => {
    withIsolatedHome((home) => {
      assert.equal(workflowHomeDir({ env: {} }), join(home, WORKFLOW_HOME_RELATIVE_DIR));
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
      const paths = workflowProjectPaths(cwd, { env: {} });
      assert.ok(paths.rootDir.startsWith(join(home, WORKFLOW_HOME_RELATIVE_DIR, WORKFLOW_PROJECTS_SUBDIR)));
      assert.equal(paths.runsDir, join(paths.rootDir, "runs"));
      assert.equal(paths.savedDir, join(paths.rootDir, "saved"));
      assert.equal(paths.settingsPath, join(paths.rootDir, "settings.json"));
    });
  });

  it("uses an explicit absolute persistence root before env and homedir defaults", () => {
    withIsolatedHome((_home, cwd) => {
      const explicitRoot = mkdtempSync(join(tmpdir(), "ap-dw-root-explicit-"));
      const envRoot = mkdtempSync(join(tmpdir(), "ap-dw-root-env-"));
      try {
        const paths = workflowProjectPaths(cwd, {
          persistenceRoot: explicitRoot,
          env: { [ORCHESTRATOR_PERSISTENCE_ROOT_ENV]: envRoot },
        });
        assert.ok(paths.rootDir.startsWith(join(explicitRoot, WORKFLOW_PROJECTS_SUBDIR)));
        assert.equal(workflowHomeDir({ persistenceRoot: explicitRoot }), explicitRoot);
      } finally {
        rmSync(explicitRoot, { recursive: true, force: true });
        rmSync(envRoot, { recursive: true, force: true });
      }
    });
  });

  it("uses ORCHESTRATOR_PERSISTENCE_ROOT when no explicit root is supplied", () => {
    withIsolatedHome((_home, cwd) => {
      const envRoot = mkdtempSync(join(tmpdir(), "ap-dw-root-env-"));
      try {
        const paths = workflowProjectPaths(cwd, { env: { [ORCHESTRATOR_PERSISTENCE_ROOT_ENV]: envRoot } });
        assert.ok(paths.rootDir.startsWith(join(envRoot, WORKFLOW_PROJECTS_SUBDIR)));
        assert.equal(workflowHomeDir({ env: { [ORCHESTRATOR_PERSISTENCE_ROOT_ENV]: envRoot } }), envRoot);
      } finally {
        rmSync(envRoot, { recursive: true, force: true });
      }
    });
  });

  it("rejects relative explicit and env persistence roots", () => {
    withIsolatedHome((_home, cwd) => {
      assert.throws(() => workflowProjectPaths(cwd, { persistenceRoot: "relative-root" }), /persistenceRoot.*absolute/);
      assert.throws(
        () => workflowProjectPaths(cwd, { env: { [ORCHESTRATOR_PERSISTENCE_ROOT_ENV]: "relative-root" } }),
        /ORCHESTRATOR_PERSISTENCE_ROOT.*absolute/,
      );
    });
  });
});
