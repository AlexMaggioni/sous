import assert from "node:assert/strict";
import { hasEventLog, type RunEventLog } from "../../src/runs/persistence/run-event-persistence.js";
import type { WorkflowManager } from "../../src/workflow-manager.js";

/** The event log of a manager's store. It fails the test when the store keeps none. */
export function eventLog(manager: WorkflowManager): RunEventLog {
  const store = manager.getPersistence();
  assert.ok(hasEventLog(store), "the manager's store keeps an event log");
  return store;
}
