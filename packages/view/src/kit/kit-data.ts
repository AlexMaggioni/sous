// Sample sous data for the kit: a workflow file, its diff since the last approval, a skill and some inputs.
import type { Input, WorkflowDiff } from "../api/contract.ts";

export const WORKFLOW_PATH = "/Users/maya/code/billing/.sous/workflows/ticket.js";

export const WORKFLOW_TEXT = `export const meta = {
  name: "ticket",
  description: "Implement a ticket, then review it until the reviewer approves",
  inputs: {
    ticket: { type: "string", description: "What to build", required: true },
    rounds: { type: "number", description: "Review rounds at most", default: 3 },
  },
  place: "worktree",
}

// The review rounds go on in the implementer's session.
const impl = session({ agentType: "implementer", label: "implementer" })
const built = await impl.send(\`Implement this ticket:\\n\${args.ticket}\`)

let review
for (let round = 0; round < args.rounds; round++) {
  if (review) await impl.send(\`Address this review:\\n\${review.review}\`, { label: "address review" })
  review = await agent(\`Review the change for: \${args.ticket}\`, {
    agentType: "reviewer", label: "reviewer",
    schema: { approved: "boolean", review: "string" },
  })
  if (review.approved) break
}
if (!review.approved) return { summary: built, approved: false }

await sh("pnpm test", { label: "tests" })
return { summary: built }
`;

const OLD = WORKFLOW_TEXT.replace('default: 3 },', 'default: 2 },').replace('await sh("pnpm test", { label: "tests" })', 'await sh("pnpm test --run", { label: "tests" })\nawait sh("pnpm lint", { label: "lint" })');

/** A line diff of OLD against WORKFLOW_TEXT, as sous serve sends it. */
function lineDiff(a: string, b: string): WorkflowDiff["lines"] {
  const A = a.replace(/\n$/, "").split("\n");
  const B = b.replace(/\n$/, "").split("\n");
  const dp = Array.from({ length: A.length + 1 }, () => new Array<number>(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: WorkflowDiff["lines"] = [];
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) {
      out.push({ op: " ", text: B[j]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ op: "-", text: A[i++]! });
    else out.push({ op: "+", text: B[j++]! });
  }
  while (i < A.length) out.push({ op: "-", text: A[i++]! });
  while (j < B.length) out.push({ op: "+", text: B[j++]! });
  return out;
}

export const WORKFLOW_DIFF: WorkflowDiff = { isNew: false, lines: lineDiff(OLD, WORKFLOW_TEXT) };

export const NEW_DIFF: WorkflowDiff = {
  isNew: true,
  lines: ['export const meta = { name: "hello", description: "Say hello" }', "", 'return agent("Say hello in one line.")'].map((text) => ({ op: "+" as const, text })),
  cut: true,
};

export const SKILL_PATH = "/Users/maya/.claude/skills/code-review/SKILL.md";

export const SKILL_TEXT = `---
name: code-review
description: How to review a diff
---
# Code review

Read the diff, then the code around each change. Say plainly when **nothing** blocks.

## What blocks

1. Bugs, including the edge cases the tests miss.
2. Missing tests for new behavior.
3. Broken contracts: a changed signature, output or file format.

## Before you answer

- [x] Run the tests on the branch.
- [ ] Read every file the diff touches.

| Finding | Blocks | Example |
| --- | --- | --- |
| A bug | Yes | Credit notes still round per line |
| A name | No | \`calc\` hides what it computes |

Quote the line, then say what to change:

\`\`\`ts
// src/invoices/total.ts:42
const total = lines.reduce((sum, l) => sum + round(l.amount), 0)
\`\`\`

> Keep the review short. One finding per line.
`;

// The reviewer's answer, as a step shows it.
export const ANSWER_TEXT = `The change rounds each line, so credit notes still drift by a cent. **One blocker.**

1. \`total()\` rounds per line. Round once, at the end.
2. No test covers a credit note.

| File | Line | Finding |
| --- | --- | --- |
| src/invoices/total.ts | 42 | Rounds per line |
| test/invoices.test.ts | | No credit note case |

\`\`\`ts
const total = round(lines.reduce((sum, l) => sum + l.amount, 0))
\`\`\`

The [rounding rule](https://en.wikipedia.org/wiki/Rounding) has the details.
`;

export const INPUTS: Input[] = [
  { name: "ticket", type: "string", description: "What to build", required: true },
  { name: "rounds", type: "number", description: "Review rounds at most", required: false, default: 3 },
  { name: "model", type: "string", description: "The model of the implementer", required: false, default: "opus", choices: ["opus", "sonnet", "haiku"] },
  { name: "dry_run", type: "boolean", description: "Plan the change without writing files", required: false, default: false },
  { name: "labels", type: "json", description: "Linear labels to set on the ticket", required: false, default: ["billing", "bug"] },
];
