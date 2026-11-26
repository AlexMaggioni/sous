// A worker process that the test kills. It runs a run's worker with a fake runner. The step
// labelled "second" prints SECOND_STARTED and never ends, so the test can kill the process there.

import { homePaths } from "@sous-run/engine";
import { fakeRunner, inProcess } from "@sous-run/engine/testing";

const [home, runId] = process.argv.slice(2);
if (!home || !runId) throw new Error("crash-worker needs a home and a run id");

const { runner } = fakeRunner((call) => {
  if (call.label !== "second") return "one";
  process.stdout.write("SECOND_STARTED\n");
  setInterval(() => {}, 1_000);
  return new Promise<never>(() => {});
});
inProcess({ inner: runner }).launch(homePaths(home), runId, "start");
