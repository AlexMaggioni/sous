// The file `orc stop --step` writes its requests to. It holds one JSON object per line, until the
// worker takes them.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { requestStepStop, takeStepStops, type StepStop } from "../../src/runs/records.js";
import { stopRequestFile } from "../../src/runs/store.js";
import { setup } from "./fixture.js";

const RUN = "run-1";

const build: StepStop = { step: "build", calls: [{ scope: RUN, label: "build", callIndex: 2 }] };
const nested: StepStop = {
  step: "ticket A: build",
  calls: [{ scope: `${RUN}-nested1`, label: "build" }, { scope: `${RUN}-nested2`, label: "build", callIndex: 0 }],
};

describe("the step stop file", () => {
  it("holds one JSON object per line, one line for each request, in the order they came", () => {
    const { paths } = setup();
    requestStepStop(paths, RUN, build);
    requestStepStop(paths, RUN, nested);
    const text = readFileSync(stopRequestFile(paths, RUN), "utf8");
    assert.equal(text, `${JSON.stringify(build)}\n${JSON.stringify(nested)}\n`);
    const lines = text.split("\n");
    assert.equal(lines.length, 3, "two lines and the empty text after the last newline");
    assert.deepEqual(lines.slice(0, 2).map((line) => JSON.parse(line) as StepStop), [build, nested]);
  });

  it("is a file of its own for each run, next to the record", () => {
    const { paths } = setup();
    requestStepStop(paths, "run-a", build);
    requestStepStop(paths, "run-b", nested);
    assert.deepEqual(JSON.parse(readFileSync(stopRequestFile(paths, "run-a"), "utf8")), build);
    assert.deepEqual(JSON.parse(readFileSync(stopRequestFile(paths, "run-b"), "utf8")), nested);
  });

  it("is taken whole, so the requests come back in order, the file is gone and a second take is empty", () => {
    const { paths } = setup();
    requestStepStop(paths, RUN, build);
    requestStepStop(paths, RUN, nested);
    assert.deepEqual(takeStepStops(paths, RUN), [build, nested]);
    assert.equal(existsSync(stopRequestFile(paths, RUN)), false);
    assert.deepEqual(takeStepStops(paths, RUN), []);
  });

  it("is empty to take when no request was made", () => {
    const { paths } = setup();
    assert.deepEqual(takeStepStops(paths, RUN), []);
  });

  it("starts a new file for a request that lands after a take", () => {
    const { paths } = setup();
    requestStepStop(paths, RUN, build);
    assert.deepEqual(takeStepStops(paths, RUN), [build]);
    requestStepStop(paths, RUN, nested);
    assert.equal(readFileSync(stopRequestFile(paths, RUN), "utf8"), `${JSON.stringify(nested)}\n`);
    assert.deepEqual(takeStepStops(paths, RUN), [nested]);
  });
});
