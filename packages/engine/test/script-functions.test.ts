import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TSchema } from "typebox";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import type { AgentResult, StepRequest } from "../src/steps/agent-run.js";
import type { AgentRunner } from "../src/steps/agent-runner.js";
import { runWorkflow } from "../src/workflow.js";

// The script functions as the guide documents them: what a bad call says, a loop of agent steps,
// choose() with none, pipeline(), and the four functions an older engine had.

interface Call {
  prompt: string;
  options: Record<string, unknown>;
}

/** An agent runner that records each call and answers with `answer`. */
function recordingRunner(answer: (prompt: string, options: Record<string, unknown>, calls: Call[]) => unknown | Promise<unknown>): {
  runner: AgentRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const runner: AgentRunner = {
    async run<S extends TSchema | undefined = undefined>(prompt: string, options?: StepRequest<S>): Promise<AgentResult<S>> {
      const opts = { ...(options ?? {}) } as Record<string, unknown>;
      calls.push({ prompt, options: opts });
      return (await answer(prompt, opts, calls)) as AgentResult<S>;
    },
  };
  return { runner, calls };
}

const META = "export const meta = { name: 'script', description: 'script functions' }";

/** The script's result, copied out of the script's realm so deepEqual can compare it. */
async function resultOf<T>(body: string, options: Parameters<typeof runWorkflow>[1]): Promise<T> {
  const run = await runWorkflow(`${META}\n${body}`, { persistLogs: false, ...options });
  return JSON.parse(JSON.stringify(run.result)) as T;
}

/** The error a script's run fails with. */
async function failureOf(body: string, options: Parameters<typeof runWorkflow>[1]): Promise<WorkflowError> {
  try {
    await runWorkflow(`${META}\n${body}`, { persistLogs: false, ...options });
  } catch (error) {
    assert.ok(error instanceof WorkflowError, `expected a WorkflowError, got ${String(error)}`);
    return error;
  }
  assert.fail("the run should have failed");
}

const unused = recordingRunner(() => "unused").runner;

describe("a bad call to a script function fails the run with its message", () => {
  // Each row is one message of the helper that builds them. The calls all break the same check.
  const argumentChecks: Array<{ message: string; calls: string[] }> = [
    { message: "sh(command) needs a command string", calls: ["sh()", "sh(42)", "sh('')", "sh('  \\n ')"] },
    { message: "js(source, input) needs the code as a string", calls: ["js()", "js(42)", "js({ code: 'return 1' })"] },
    { message: "py(source, input) needs the code as a string", calls: ["py()", "py(42)", "py(['return 1'])"] },
    { message: "run(file) needs a file path", calls: ["run()", "run(7)", "run('')", "run('   ')"] },
    { message: "waitUntil(command) needs a command string", calls: ["waitUntil()", "waitUntil(3)", "waitUntil('')", "waitUntil('  ')"] },
    { message: "ask(question) needs a question", calls: ["ask()", "ask(5)", "ask('')", "ask('   ')"] },
    { message: "breakpoint(title) needs a title", calls: ["breakpoint()", "breakpoint(1)", "breakpoint('')", "breakpoint('  ')"] },
    { message: "choose() needs at least one step or workflow", calls: ["choose('What next?')", "choose('What next?', { steps: {}, workflows: [] })"] },
  ];
  for (const { message, calls } of argumentChecks) {
    it(message, async () => {
      for (const call of calls) {
        const error = await failureOf(`return await ${call}`, { agent: unused });
        assert.equal(error.message, message, call);
        assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, call);
        assert.equal(error.recoverable, false, `${call}: the run does not retry a bad call`);
      }
    });
  }

  it("choose() needs at least one step or workflow, also with any: true and no saved workflow", async () => {
    const error = await failureOf("return await choose('What next?', { any: true })", { agent: unused, listSavedWorkflows: () => [] });
    assert.equal(error.message, "choose() needs at least one step or workflow");
  });

  it('breakpoint "Check" was sent back 5 times, the default of max', async () => {
    const { runner, calls } = recordingRunner(() => "draft");
    let asked = 0;
    const error = await failureOf("return await breakpoint('Check', () => agent('write it', { label: 'draft' }))", {
      agent: runner,
      confirm: async () => {
        asked++;
        return { decision: "send back", note: "again" };
      },
    });
    assert.equal(error.message, 'breakpoint "Check" was sent back 5 times');
    assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
    assert.equal(calls.length, 5, "the step ran 5 times");
    assert.equal(asked, 5, "the person was asked once per round, and not a sixth time");
  });

  it('breakpoint "Check" was sent back 2 times, with max: 2', async () => {
    const { runner, calls } = recordingRunner(() => "draft");
    let asked = 0;
    const error = await failureOf("return await breakpoint('Check', () => agent('write it', { label: 'draft' }), { max: 2 })", {
      agent: runner,
      confirm: async () => {
        asked++;
        return "send back please";
      },
    });
    assert.equal(error.message, 'breakpoint "Check" was sent back 2 times');
    assert.equal(calls.length, 2);
    assert.equal(asked, 2);
  });

  it("choose(): the agent picked a name that is not listed", async () => {
    const { runner } = recordingRunner(() => ({ choice: "ghost", reason: "it sounded right" }));
    const error = await failureOf("return await choose('What next?', { steps: { fix: () => 'fixed', skip: () => 'skipped' } })", { agent: runner });
    assert.equal(error.message, 'choose(): the agent picked "ghost", which is not listed');
    assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
  });

  it('choose() fails when the agent picks "none" without none: true, since none is not listed', async () => {
    const { runner } = recordingRunner(() => ({ choice: "none", reason: "nothing to do" }));
    const error = await failureOf("return await choose('What next?', { steps: { fix: () => 'fixed' } })", { agent: runner });
    assert.equal(error.message, 'choose(): the agent picked "none", which is not listed');
  });

});

describe("a loop of agent steps", () => {
  it("waits for an async function, and makes each agent step its own call", async () => {
    const { runner, calls } = recordingRunner((_prompt, _options, all) => (all.length < 3 ? "not yet" : "done"));
    const value = await resultOf<string>(
      `let value
for (let attempt = 0; attempt < 4; attempt++) {
  value = await agent('try ' + attempt, { label: 'try' })
  if (value === 'done') break
}
return value`,
      { agent: runner },
    );
    assert.equal(value, "done");
    assert.deepEqual(calls.map((call) => call.prompt), ["try 0", "try 1", "try 2"]);
  });
});

describe("choose() with none: true", () => {
  const STEPS = "{ none: true, steps: { fix: { description: 'Fix the bug', run: () => agent('fix it', { label: 'fixer' }) } } }";

  it("offers none next to the listed steps, and returns it with no result when the agent picks it", async () => {
    const { runner, calls } = recordingRunner((_prompt, options) => (options.label === "choose" ? { choice: "none", reason: "all done" } : "fixed"));
    const out = await resultOf<Record<string, unknown>>(`return await choose('What next?', ${STEPS})`, { agent: runner });
    assert.deepEqual(out, { choice: "none", reason: "all done" });
    assert.equal(calls.length, 1, "no listed step ran");
    const schema = calls[0]!.options.schema as { properties: { choice: { enum: string[] } } };
    assert.deepEqual(schema.properties.choice.enum, ["fix", "none"]);
    assert.match(calls[0]!.prompt, /\n- fix: Fix the bug\n- none: Do nothing more\.$/);
  });

  it("still runs a listed step when the agent picks one", async () => {
    const { runner } = recordingRunner((_prompt, options) => (options.label === "choose" ? { choice: "fix", reason: "a bug" } : "fixed"));
    const out = await resultOf<Record<string, unknown>>(`return await choose('What next?', ${STEPS})`, { agent: runner });
    assert.deepEqual(out, { choice: "fix", reason: "a bug", result: "fixed" });
  });

  it("works with no steps and no workflows, since none is a choice", async () => {
    const { runner, calls } = recordingRunner(() => ({ choice: "none", reason: "nothing to pick" }));
    const out = await resultOf<Record<string, unknown>>("return await choose('What next?', { none: true })", { agent: runner });
    assert.deepEqual(out, { choice: "none", reason: "nothing to pick" });
    const schema = calls[0]!.options.schema as { properties: { choice: { enum: string[] } } };
    assert.deepEqual(schema.properties.choice.enum, ["none"]);
  });

  it("does not run a saved workflow when the agent picks none", async () => {
    const { runner } = recordingRunner(() => ({ choice: "none", reason: "skip" }));
    let loaded = 0;
    const out = await resultOf<Record<string, unknown>>("return await choose('What next?', { none: true, workflows: ['triage'] })", {
      agent: runner,
      loadSavedWorkflow: (name) => {
        loaded++;
        return name === "triage" ? `${META}\nreturn 'triaged'` : undefined;
      },
    });
    assert.deepEqual(out, { choice: "none", reason: "skip" });
    assert.equal(loaded, 0);
  });
});

describe("pipeline()", () => {
  it("gives each stage the last stage's result, the item and its index, and keeps the input order", { timeout: 30_000 }, async () => {
    // The first item's first stage ends last, so the results can only be in input order by design.
    let releaseFirst: () => void = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { runner, calls } = recordingRunner(async (prompt) => {
      if (prompt === "stage1 a") await firstHeld;
      if (prompt.startsWith("stage2 done(stage1 b)")) releaseFirst();
      return `done(${prompt})`;
    });
    const results = await resultOf<string[]>(
      `return await pipeline(['a', 'b', 'c'],
  (item) => agent('stage1 ' + item, { label: 'one ' + item }),
  (previous, item, index) => agent('stage2 ' + previous + ' ' + item + ' ' + index, { label: 'two ' + item }))`,
      { agent: runner, concurrency: 4 },
    );
    assert.deepEqual(results, [
      "done(stage2 done(stage1 a) a 0)",
      "done(stage2 done(stage1 b) b 1)",
      "done(stage2 done(stage1 c) c 2)",
    ]);
    const order = calls.map((call) => call.prompt);
    for (const item of ["a", "b", "c"]) {
      assert.ok(order.indexOf(`stage1 ${item}`) < order.findIndex((prompt) => prompt.startsWith("stage2") && prompt.includes(` ${item} `)), `${item}: stage 2 starts after stage 1`);
    }
  });

  it("runs the items at once, so a second item's first stage starts before the first item's ends", { timeout: 30_000 }, async () => {
    const started: string[] = [];
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runner } = recordingRunner(async (prompt) => {
      started.push(prompt);
      if (prompt === "work a") await held;
      if (prompt === "work b") release();
      return prompt;
    });
    const results = await resultOf<string[]>("return await pipeline(['a', 'b'], (item) => agent('work ' + item, { label: 'w ' + item }))", {
      agent: runner,
      concurrency: 4,
    });
    assert.deepEqual(results, ["work a", "work b"]);
    assert.deepEqual(started, ["work a", "work b"]);
  });

  it("with no stages gives the items back", async () => {
    const results = await resultOf<number[]>("return await pipeline([1, 2, 3])", { agent: unused });
    assert.deepEqual(results, [1, 2, 3]);
  });
});

describe("a script that calls one of the four functions an older engine had", () => {
  const failsWithReferenceError = (name: string) => async () => {
    const error = await failureOf(`return await ${name}('is it right?', { agents: 3 })`, { agent: unused });
    assert.equal(error.code, WorkflowErrorCode.SCRIPT_ERROR);
    assert.equal(error.message, `${name} is not defined`);
  };
  it("a script that calls verify fails with a ReferenceError", failsWithReferenceError("verify"));
  it("a script that calls judgePanel fails with a ReferenceError", failsWithReferenceError("judgePanel"));
  it("a script that calls loopUntilDry fails with a ReferenceError", failsWithReferenceError("loopUntilDry"));
  it("a script that calls completenessCheck fails with a ReferenceError", failsWithReferenceError("completenessCheck"));
});
