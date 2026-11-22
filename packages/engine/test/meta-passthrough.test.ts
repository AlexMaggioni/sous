import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TSchema } from "typebox";
import type { AgentResult, RunOptions } from "../src/steps/agent-run.js";
import type { AgentRunner } from "../src/steps/agent-runner.js";
import type { JournalEntry } from "../src/workflow-result.js";
import { runWorkflow } from "../src/workflow.js";

// A script may still set agent({ meta, promptMeta }). They count in the call's inputs, so a
// resumed session notices a change, but no step reads them and they stay out of the resume hash.

describe("agent({ meta, promptMeta })", () => {
  it("are accepted, and no step receives them", async () => {
    let given: Record<string, unknown> | undefined;
    const capturing: AgentRunner = {
      async run<S extends TSchema | undefined = undefined>(
        _prompt: string,
        options?: RunOptions<S>,
      ): Promise<AgentResult<S>> {
        given = options as Record<string, unknown> | undefined;
        return "ok" as AgentResult<S>;
      },
    };
    const script = `export const meta = { name: 'm', description: 'meta' }
const a = await agent('p', {
  label: 'a',
  meta: { credsRef: 'vault://qa', allowedDomains: ['preview.example.com'] },
  promptMeta: { viewport: '1280x800' },
})
return a`;

    const result = await runWorkflow(script, { agent: capturing, persistLogs: false });

    assert.equal(result.result, "ok");
    assert.ok(given);
    assert.equal("meta" in given, false);
    assert.equal("promptMeta" in given, false);
  });

  it("does NOT fold meta/promptMeta into the resume identity hash", async () => {
    const echo: AgentRunner = {
      async run<S extends TSchema | undefined = undefined>(prompt: string): Promise<AgentResult<S>> {
        return `ran:${prompt}` as AgentResult<S>;
      },
    };
    const journalOf = async (withMeta: boolean): Promise<JournalEntry[]> => {
      const journal: JournalEntry[] = [];
      const opts = withMeta
        ? `{ label: 'a', meta: { credsRef: 'vault://qa' }, promptMeta: { viewport: '1280x800' } }`
        : `{ label: 'a' }`;
      const script = `export const meta = { name: 'm2', description: 'meta' }
return await agent('same', ${opts})`;
      await runWorkflow(script, {
        agent: echo,
        persistLogs: false,
        onAgentJournal: (e) => journal.push(e),
      });
      return journal;
    };

    const [withMeta] = await journalOf(true);
    const [withoutMeta] = await journalOf(false);
    assert.equal(
      withMeta.hash,
      withoutMeta.hash,
      "adding meta/promptMeta must keep the resume key byte-identical (not part of the identity)",
    );
  });
});
