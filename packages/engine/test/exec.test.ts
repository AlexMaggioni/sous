// Code steps: a shell command, JS, Python or a script file, run in the step's folder. Moved
// from orc's units test with the code it tests.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { WorkflowError } from "../src/errors.js";
import { runExecSpec } from "../src/steps/exec.js";

const temp = (name: string) => mkdtempSync(join(tmpdir(), `engine-${name}-`));

describe("code steps", () => {
  it("run sh, js, py and a script file, and return code, output and result", async () => {
    const cwd = temp("exec");
    writeFileSync(join(cwd, "step.py"), "import json, os, sys\nd = json.load(sys.stdin)\nopen(os.environ['ORC_RESULT'], 'w').write(json.dumps(d['n'] * 2))\n");
    const sh = await runExecSpec({ kind: "sh", command: "echo hi; pwd" }, { cwd });
    assert.equal(sh.code, 0);
    assert.match(sh.stdout, /^hi\n/);
    assert.ok(sh.stdout.trim().endsWith(cwd.split("/").pop()!));
    assert.equal((await runExecSpec({ kind: "js", source: "return input.a + input.b", input: { a: 2, b: 3 } }, { cwd })).result, 5);
    assert.deepEqual((await runExecSpec({ kind: "py", source: "return [x * 2 for x in input]", input: [1, 2] }, { cwd })).result, [2, 4]);
    assert.equal((await runExecSpec({ kind: "file", file: "step.py", input: { n: 21 } }, { cwd })).result, 42);
  });

  it("fail on a non-zero exit unless allowed, and on the time limit", async () => {
    const cwd = temp("exec-fail");
    await assert.rejects(runExecSpec({ kind: "sh", command: "echo broken >&2; exit 3" }, { cwd }), (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.match(error.message, /exited with code 3: broken/);
      assert.equal(error.recoverable, true);
      return true;
    });
    assert.equal((await runExecSpec({ kind: "sh", command: "exit 3", allowFail: true }, { cwd })).code, 3);
    await assert.rejects(runExecSpec({ kind: "sh", command: "sleep 5" }, { cwd, timeoutMs: 200 }), /timed out/);
  });

  it("wait until a command succeeds, checking again and again", async () => {
    const cwd = temp("exec-wait");
    setTimeout(() => writeFileSync(join(cwd, "done"), ""), 1200);
    const result = await runExecSpec({ kind: "wait", command: "test -f done", everySeconds: 1, timeoutSeconds: 10 }, { cwd });
    assert.ok((result.checks ?? 0) >= 2);
    await assert.rejects(runExecSpec({ kind: "wait", command: "false", everySeconds: 1, timeoutSeconds: 1 }, { cwd }), /still not true/);
  });
});
