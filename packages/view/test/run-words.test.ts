import { describe, expect, test } from "vitest";
import { commandOf } from "../src/api/send.ts";
import { resumeFor } from "../src/pages/run/run-words.ts";

describe("the resume a run calls for", () => {
  test("a run paused at its budget asks for twice the budget", () => {
    expect(resumeFor({ id: "r1", pauseReason: "budget", budget: 4 })).toEqual(["resume", "r1", "--budget", "8"]);
  });

  test("a run paused for another reason, or with no budget, resumes as it is", () => {
    expect(resumeFor({ id: "r1", pauseReason: "time_limit", budget: 4 })).toEqual(["resume", "r1"]);
    expect(resumeFor({ id: "r1", pauseReason: "budget" })).toEqual(["resume", "r1"]);
  });

  test("picks the workflow text when it changed since the run started", () => {
    expect(resumeFor({ id: "r1" }, "latest")).toEqual(["resume", "r1", "--latest"]);
    expect(resumeFor({ id: "r1", pauseReason: "budget", budget: 2 }, "same")).toEqual(["resume", "r1", "--same", "--budget", "4"]);
  });
});

describe("the command a toast shows", () => {
  test("plain words stay bare", () => {
    expect(commandOf(["stop", "r-2c8f1d"])).toBe("sous stop r-2c8f1d");
  });

  test("a word the shell would read goes in single quotes, so $ and ! stay as they are", () => {
    expect(commandOf(["tell", "r1", "Use $HOME, not ~!"])).toBe(`sous tell r1 'Use $HOME, not ~!'`);
  });

  test("a single quote inside a word closes the quotes and adds it escaped", () => {
    expect(commandOf(["answer", "q1", "it's fine"])).toBe(`sous answer q1 'it'\\''s fine'`);
  });

  test("an empty word stays a word", () => {
    expect(commandOf(["answer", "q1", ""])).toBe("sous answer q1 ''");
  });
});
