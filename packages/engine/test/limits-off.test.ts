import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WorkflowErrorCode } from "../src/errors.js";
import { PERSON, testHome } from "../src/testing.js";
import { runWorkflow } from "../src/workflow.js";
import { workflowExtras } from "../src/workflows/meta.js";
import { dryRun } from "../src/workflows/dry-run.js";
import { runnerFrom } from "./helpers/runners.js";

// Every limit is off unless the script sets it (DESIGN.md, decision 6). The calls of a run, how
// deep workflows nest and how often a breakpoint is sent back have no default. The run's own
// options set the first two, and so does the root workflow's meta. A dry run keeps a cap of its
// own, since it starts no program and a loop in the script would never end.

const echo = runnerFrom((prompt) => `ran:${prompt}`);

/** A script with a meta of `extra` and the body `body`. */
function script(body: string, extra = ""): string {
  return `export const meta = { name: 'limits', description: 'limits'${extra} }\n${body}`;
}

/** The workflow `level`: one agent step, then itself one level deeper until `stop`. */
const LEVEL = `export const meta = { name: 'level', description: 'one level' }
await agent('level ' + args.n, { label: 'l' + args.n, until: 'turn' })
if (args.n === args.stop) return args.n
return await workflow('level', { n: args.n + 1, stop: args.stop })`;

/** A run that nests `stop` levels of LEVEL, with a meta of `extra`. Its result is the deepest
 *  level reached, or the error's message. */
function nested(stop: number, extra = "") {
  const body = `try { return await workflow('level', { n: 1, stop: ${stop} }) } catch (e) { return String(e && e.message || e) }`;
  return script(body, extra);
}

const loadLevel = (name: string) => (name === "level" ? LEVEL : undefined);

describe("the calls of a run", () => {
  it("have no cap by default: 1001 agent steps run", async () => {
    const run = await runWorkflow(script("for (let i = 0; i < 1001; i++) await agent('x' + i, { label: 'a' + i, until: 'turn' })\nreturn 'all'"), {
      agent: echo,
      persistLogs: false,
    });
    assert.equal(run.result, "all");
    assert.equal(run.agentCount, 1001);
  });

  it("stop at meta.maxAgents", async () => {
    const run = runWorkflow(script("for (let i = 0; i < 5; i++) await agent('x' + i, { label: 'a' + i, until: 'turn' })", ", maxAgents: 2"), {
      agent: echo,
      persistLogs: false,
    });
    await assert.rejects(run, (error: { code?: string; message: string }) => {
      assert.equal(error.code, WorkflowErrorCode.AGENT_LIMIT_EXCEEDED);
      assert.match(error.message, /\b2\b/);
      return true;
    });
  });

  it("count a nested workflow's steps against the root's meta.maxAgents", async () => {
    const run = await runWorkflow(nested(4, ", maxAgents: 3"), { agent: echo, persistLogs: false, savedWorkflows: { load: loadLevel } });
    assert.match(String(run.result), /limit/i, "the fourth level's step is refused");
  });

  it("hold the smaller of the run's own maxAgents and the meta's", async () => {
    const five = "for (let i = 0; i < 5; i++) await agent('x' + i, { label: 'a' + i, until: 'turn' })\nreturn 'all'";
    const refused = (error: { code?: string; message: string }) => {
      assert.equal(error.code, WorkflowErrorCode.AGENT_LIMIT_EXCEEDED);
      assert.match(error.message, /limit of 2\b/);
      return true;
    };
    await assert.rejects(runWorkflow(script(five, ", maxAgents: 2"), { agent: echo, persistLogs: false, maxAgents: 10 }), refused);
    await assert.rejects(runWorkflow(script(five, ", maxAgents: 10"), { agent: echo, persistLogs: false, maxAgents: 2 }), refused);
    const both = await runWorkflow(script(five, ", maxAgents: 10"), { agent: echo, persistLogs: false, maxAgents: 20 });
    assert.equal(both.result, "all");
  });
});

describe("how deep workflows nest", () => {
  it("has no cap by default: seven levels run", async () => {
    const run = await runWorkflow(nested(7), { agent: echo, persistLogs: false, savedWorkflows: { load: loadLevel } });
    assert.equal(run.result, 7);
  });

  it("stops at meta.maxNestingDepth, in every nested level", async () => {
    const three = await runWorkflow(nested(3, ", maxNestingDepth: 3"), { agent: echo, persistLogs: false, savedWorkflows: { load: loadLevel } });
    assert.equal(three.result, 3);
    const four = await runWorkflow(nested(4, ", maxNestingDepth: 3"), { agent: echo, persistLogs: false, savedWorkflows: { load: loadLevel } });
    assert.match(String(four.result), /at most 3 levels deep/);
  });

  it("stops at the run's own maxNestingDepth, or the meta's when it is smaller", async () => {
    const run = await runWorkflow(nested(3), { agent: echo, persistLogs: false, savedWorkflows: { load: loadLevel }, maxNestingDepth: 2 });
    assert.match(String(run.result), /at most 2 levels deep/);
    const meta = await runWorkflow(nested(3, ", maxNestingDepth: 2"), { agent: echo, persistLogs: false, savedWorkflows: { load: loadLevel }, maxNestingDepth: 5 });
    assert.match(String(meta.result), /at most 2 levels deep/);
  });
});

describe("a breakpoint sent back", () => {
  it("has no cap by default: seven send-backs, then approve", async () => {
    let asked = 0;
    const run = await runWorkflow(script("return await breakpoint('Check', (note) => agent('write it ' + (note ?? ''), { label: 'draft', until: 'turn' }))"), {
      agent: echo,
      persistLogs: false,
      confirm: async () => (++asked <= 7 ? { decision: "send back", note: `again ${asked}` } : "approve"),
    });
    assert.equal(asked, 8);
    assert.equal(run.result, "ran:write it again 7");
  });
});

describe("meta settings for limits", () => {
  it("must be whole numbers of at least 1", () => {
    for (const bad of ["0", "1.5", "'3'", "-2", "null"]) {
      const extras = workflowExtras({ name: "m", description: "d", maxAgents: eval(bad), maxNestingDepth: eval(bad) } as never);
      assert.ok(
        extras.metaProblems?.some((problem) => problem.startsWith("meta.maxAgents must be a whole number of at least 1")),
        `maxAgents ${bad}: ${JSON.stringify(extras.metaProblems)}`,
      );
      assert.ok(
        extras.metaProblems?.some((problem) => problem.startsWith("meta.maxNestingDepth must be a whole number of at least 1")),
        `maxNestingDepth ${bad}: ${JSON.stringify(extras.metaProblems)}`,
      );
    }
    assert.equal(workflowExtras({ name: "m", description: "d", maxAgents: 5, maxNestingDepth: 2 } as never).metaProblems, undefined);
  });
});

describe("a dry run", () => {
  it("keeps a cap of 1000 calls, so a loop in the script ends (1001 calls at once stand in for a loop)", async () => {
    const { paths, projectDir } = testHome({
      spin: "export const meta = { name: 'spin', description: 'a loop with no end' }\nawait parallel(Array.from({ length: 1001 }, (_, i) => () => agent('x' + i, { label: 'a' + i, until: 'turn' })))",
    });
    const dry = await dryRun(paths, { who: PERSON, workflow: "spin", projectDir, inputs: {} });
    assert.equal(dry.status, "failed");
    assert.match(dry.reason ?? "", /dry run/i, "the reason names the dry run's cap, not a setting the script never set");
    assert.match(dry.reason ?? "", /1000/);
    assert.doesNotMatch(dry.reason ?? "", /set by maxAgents/);
  });

  it("keeps the script's own meta.maxAgents when it is under the dry run's cap", async () => {
    const { paths, projectDir } = testHome({
      three: "export const meta = { name: 'three', description: 'three at most', maxAgents: 3 }\nfor (let i = 0; i < 5; i++) await agent('x' + i, { label: 'a' + i, until: 'turn' })",
    });
    const dry = await dryRun(paths, { who: PERSON, workflow: "three", projectDir, inputs: {} });
    assert.equal(dry.status, "failed");
    assert.match(dry.reason ?? "", /limit of 3\b.*maxAgents/);
    assert.equal(dry.agents.length, 3);
  });
});
