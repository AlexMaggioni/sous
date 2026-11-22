import test from "node:test";
import assert from "node:assert/strict";

// Same-package unit test: relative ../src import (resolved by tsx; sibling @orchestrator/*
// deps it pulls in resolve to their built dist, which `pnpm test` builds first).
import { createRun, dryRun, openWorkflowDir } from "../src/index.js";

test("@orchestrator/engine public entry is reachable via ../src", () => {
  assert.equal(typeof createRun, "function");
  assert.equal(typeof dryRun, "function");
  assert.equal(typeof openWorkflowDir, "function");
});
