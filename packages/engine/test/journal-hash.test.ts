import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { AgentRunner } from "../src/steps/agent-runner.js";
import type { AgentSessionRef } from "../src/workflow-result.js";
import type { StepRequest } from "../src/steps/agent-run.js";
import type { JournalEntry } from "../src/workflow.js";
import { runWorkflow } from "../src/workflow.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";

// hashAgentCall() is module-private, but every live agent() emits its call hash on the
// JournalEntry (workflow.ts: onAgentJournal({ index, hash, result })). The resume
// contract is "replay a cached result iff cached.hash === hash", so this hash is the
// load-bearing resume key: it MUST be byte-stable for a fixed call identity and MUST
// change when any identity input (prompt / model / mode-when-set / phase / agentType / agentDef /
// schema) changes. configOptions is refused now. tier stays in the identity as a constant null,
// so old journals keep their keys. These tests pin that through the observable journal.

const echo = {
  async run(prompt: string) {
    return `ran:${prompt}`;
  },
};

/** Run a script with the echo agent and return its journal entries in index order. */
async function journalOf(script: string, args?: unknown): Promise<JournalEntry[]> {
  const journal: JournalEntry[] = [];
  await runWorkflow(script, {
    agent: echo,
    args,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  return journal.sort((a, b) => a.index - b.index);
}

// until: "turn" keeps the bytes a step had before steps ran until done.
const singleCall = `export const meta = { name: 'h', description: 'hash' }
const a = await agent('only', { label: 'a', until: 'turn' })
return a`;

describe("journal hash (hashAgentCall byte-stability)", () => {
  it("keeps call and input hash fixtures unchanged by continuation-adjacent metadata", async () => {
    const sessionRef: AgentSessionRef = {
      sessionId: "continuation-session",
      backendId: "codex",
      poolKey: "codex",
      initializeMeta: { vendor: "hash-neutral", nested: { stable: true } },
      cwd: "/workspace/project",
      reopen: { load: true, resume: true, list: false, fork: false },
    };
    const run = async (withContinuationMetadata: boolean) => {
      const journal: JournalEntry[] = [];
      let inputsHash: string | undefined;
      const runner: AgentRunner = {
        async run(prompt: string, options: StepRequest) {
          inputsHash = options.callInputsHash;
          if (withContinuationMetadata) {
            const directive: StepRequest = { ...options, continueFromSession: sessionRef };
            assert.deepEqual(directive.continueFromSession, sessionRef);
            options.onSessionOpen?.(sessionRef);
            options.onResultProvenance?.({
              source: "live",
              continuation: { reattached: true, method: "resume" },
            });
          }
          return `ran:${prompt}`;
        },
      };
      const result = await runWorkflow(singleCall, {
        agent: runner,
        persistLogs: false,
        onAgentJournal: (entry) => journal.push(entry),
      });
      return { entry: journal[0], inputsHash, result };
    };

    const plain = await run(false);
    const adjacent = await run(true);
    const expectedInputs = createHash("sha256")
      .update(
        JSON.stringify({
          backends: null,
          cwd: null,
          images: null,
          isolation: null,
          keepSession: false,
          label: "a",
          mcpServers: null,
          meta: null,
          promptMeta: null,
        }),
      )
      .digest("hex");
    const markedEntry: JournalEntry = {
      ...adjacent.entry,
      call: { kind: "agent", label: "a", continuation: { method: "resume" } },
    };

    // The digest of {"prompt":"only","model":null,"tier":null,"phase":null,"agentType":null,"agentDef":null,"schema":null},
    // in that field order, with null for each input the call leaves out.
    assert.equal(plain.entry.hash, "2aa09c56e72fb040ff729ab7ada54158759da157dd048aecd467867debc30e99");
    assert.equal(adjacent.entry.hash, plain.entry.hash);
    assert.equal(markedEntry.hash, plain.entry.hash);
    assert.equal(plain.inputsHash, expectedInputs);
    assert.equal(adjacent.inputsHash, expectedInputs);
    assert.equal(adjacent.entry.session?.poolKey, "codex");
    assert.deepEqual(adjacent.entry.session?.initializeMeta, sessionRef.initializeMeta);
    assert.deepEqual(adjacent.result.agentSessions?.[0]?.initializeMeta, sessionRef.initializeMeta);
    const roundTrippedSession = JSON.parse(JSON.stringify(adjacent.entry.session));
    assert.deepEqual(roundTrippedSession.initializeMeta, sessionRef.initializeMeta);
    assert.equal(roundTrippedSession.sessionId, sessionRef.sessionId);
    assert.deepEqual(adjacent.result.calls?.[0]?.provenance, {
      source: "live",
      continuation: { reattached: true, method: "resume" },
    });
  });

  it("is byte-identical when args change but the call identity does not", async () => {
    const [first] = await journalOf(singleCall, { maxRounds: 6 });
    const [second] = await journalOf(singleCall, { maxRounds: 8 });

    assert.equal(first.hash, second.hash, "args are not serialized into the agent call identity");
  });

  it("changes only the edited call's hash and keeps earlier indices byte-stable", async () => {
    const base = `export const meta = { name: 'h2', description: 'hash' }
const a = await agent('alpha', { label: 'a' })
const b = await agent('beta', { label: 'b' })
return { a, b }`;
    const edited = base.replace("'beta'", "'beta-edited'");

    const before = await journalOf(base);
    const after = await journalOf(edited);

    assert.equal(before[0].hash, after[0].hash, "index 0 (unchanged prompt) keeps an identical hash");
    assert.notEqual(before[1].hash, after[1].hash, "index 1 (changed prompt) gets a different hash");
  });

  it("folds mode into the identity (mode change => different hash, same prompt/index)", async () => {
    const noMode = `export const meta = { name: 'h-mode', description: 'hash' }
const a = await agent('same', { label: 'a' })
return a`;
    const withMode = `export const meta = { name: 'h-mode', description: 'hash' }
const a = await agent('same', { label: 'a', mode: 'read-only' })
return a`;

    const [plain] = await journalOf(noMode);
    const [mode] = await journalOf(withMode);
    assert.notEqual(plain.hash, mode.hash, "adding a mode changes the resume key even for an identical prompt");
  });

  it("refuses configOptions, empty or set, before any call is hashed or journaled", async () => {
    const absent = `export const meta = { name: 'h-config-absent', description: 'hash' }
return agent('same', { label: 'a' })`;
    const refused = [
      `return agent('same', { label: 'a', configOptions: {} })`,
      `return agent('same', { label: 'a', configOptions: { zeta: 'last', alpha: true } })`,
      `return agent('same', { label: 'a', configOptions: { alpha: false, zeta: 'last' } })`,
      `return agent('same', { label: 'a', configOptions: { '2': 'two', '10': 'ten' } })`,
    ];
    const [plain] = await journalOf(absent);
    assert.ok(plain.hash);
    for (const body of refused) {
      const journal: JournalEntry[] = [];
      await assert.rejects(
        runWorkflow(`export const meta = { name: 'h-config', description: 'hash' }\n${body}`, {
          agent: echo,
          persistLogs: false,
          onAgentJournal: (e) => journal.push(e),
        }),
        (error: unknown) => {
          assert.ok(error instanceof WorkflowError, body);
          assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, body);
          assert.equal(error.message, "configOptions is gone. No program read it. Remove it from the step.", body);
          return true;
        },
      );
      assert.deepEqual(journal, [], body);
    }
  });

  it("hashes a call with no configOptions with no configOptions key, as old journals hold it", async () => {
    const source = `export const meta = { name: 'h-no-config', description: 'hash' }
return agent('same', { label: 'a', until: 'turn' })`;
    const [entry] = await journalOf(source);
    const expectedIdentity =
      '{"prompt":"same","model":null,"tier":null,"phase":null,"agentType":null,"agentDef":null,"schema":null}';
    assert.equal(entry.hash, createHash("sha256").update(expectedIdentity).digest("hex"));
  });

  it("hashes a step that runs until done, as each step does unless it sets until turn, with until done last", async () => {
    const identity = (extra: string) =>
      createHash("sha256")
        .update(`{"prompt":"same","model":null,"tier":null,"phase":null,"agentType":null,"agentDef":null,"schema":null${extra}}`)
        .digest("hex");
    const hashOf = async (options: string) =>
      (await journalOf(`export const meta = { name: 'h-done', description: 'hash' }\nreturn agent('same', { label: 'a'${options} })`))[0]!.hash;
    assert.equal(await hashOf(""), identity(',"until":"done"'));
    assert.equal(await hashOf(", until: 'done'"), identity(',"until":"done"'));
    assert.equal(await hashOf(", ask: false"), identity(',"until":"done","ask":false'));
    // The limits and the checks belong to the loop, not to the call.
    assert.equal(await hashOf(", maxTurns: 3, maxRepairs: 2, check: 'true'"), identity(',"until":"done"'));
  });

  it("folds phase into the identity (phase change => different hash)", async () => {
    const phaseA = `export const meta = { name: 'h4', description: 'hash', phases: [{ title: 'A' }, { title: 'B' }] }
phase('A')
const a = await agent('same', { label: 'a' })
return a`;
    const phaseB = `export const meta = { name: 'h4', description: 'hash', phases: [{ title: 'A' }, { title: 'B' }] }
phase('B')
const a = await agent('same', { label: 'a' })
return a`;

    const [a] = await journalOf(phaseA);
    const [b] = await journalOf(phaseB);
    assert.notEqual(a.hash, b.hash, "the active phase is part of the call identity");
  });
});
