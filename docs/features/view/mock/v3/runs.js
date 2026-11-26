/* sous view mock v3: sample runs. Each run is a tree of steps with times, tokens and activity.
   Times are offsets from the run's start. The pass at the end places every step on the time axis. */
"use strict";

/* activity lines */
const P = (t) => ({ k: "prompt", t });
const T = (n, a, r) => ({ k: "tool", n, a, r });
const X = (t) => ({ k: "text", t });
const Q = (t) => ({ k: "asks", t });
const TELL = (t, dlv) => ({ k: "tell", t, dlv: dlv || "delivered" });
const NOTE = (t) => ({ k: "note", t });
const FAIL = (t) => ({ k: "error", t });

/* step constructors. o.s is the status, done when left out. o.d is the duration in ms. */
const A = (label, agent, o) => Object.assign({ k: "agent", label, agent }, o);
const C = (kind, label, cmd, o) => Object.assign({ k: kind, label, cmd }, o);
const Ask = (label, o) => Object.assign({ k: "ask", label }, o);
const Ck = (label, o) => Object.assign({ k: "checkpoint", label }, o);
const Ch = (label, o) => Object.assign({ k: "choose", label }, o);
const Lane = (label, kids, o) => Object.assign({ k: "lane", label, kids }, o);
const Par = (label, kids, o) => Object.assign({ k: "par", label, kids }, o);
const Pipe = (label, kids, o) => Object.assign({ k: "pipe", label, kids }, o);
const Wf = (label, wf, kids, o) => Object.assign({ k: "wf", label, wf, kids }, o);
const Bp = (label, kids, o) => Object.assign({ k: "bp", label, kids }, o);
const loop = (k) => (label, max, atts, o) => Object.assign({ k, label, max, kids: atts.map((a, i) => ({ k: "attempt", label: "Attempt " + (i + 1), kids: a.steps, ok: a.ok, verdict: a.v, s: a.s })) }, o);
const Gate = loop("gate");
const Retry = loop("retry");

const S = SEC, M = MIN, H = HR, D = DAY;
const GROUPS = ["par", "pipe", "lane", "wf", "bp", "gate", "retry", "attempt", "root"];
const isGroup = (n) => GROUPS.includes(n.k);

/* live activity, added while a step runs */
const POOLS = {
  darkmode: [
    ["tool", "Read", "src/components/pricing/Toggle.tsx", "77 lines"],
    ["text", "The toggle's track color comes from a prop. I'll read it from the tokens instead."],
    ["tool", "Edit", "src/components/pricing/Toggle.tsx", "+6 -4"],
    ["tool", "Bash", "pnpm vitest run pricing", "14 passed"],
    ["tool", "Grep", '"bg-white"  src/components/pricing', "3 matches in 2 files"],
    ["tool", "Edit", "src/components/pricing/FeatureList.tsx", "+3 -3"],
    ["text", "Checking contrast for the muted text on the dark card background."],
    ["tool", "Bash", "pnpm exec contrast-check src/styles/tokens.css", "all pairs pass AA"],
    ["tool", "Edit", "test/pricing.dark.test.tsx", "+41 -0"],
    ["tool", "Bash", "pnpm vitest run pricing", "17 passed"],
    ["text", "Dark mode now covers the cards, the toggle and the feature list. Light values are unchanged."],
  ],
  review: [
    ["tool", "Grep", '"roundCents"  src', "4 matches in 3 files"],
    ["text", "roundCents still runs per line in credit notes. That keeps the old 3-decimal bug there."],
    ["tool", "Read", "src/invoices/credit.ts", "61 lines"],
    ["text", "Blocker: credit notes round per line. Suggest calling the new total() there too."],
    ["tool", "Read", "test/webhooks/retry.test.ts", "0 lines"],
    ["text", "No test covers retry.ts. That blocks too."],
  ],
  queue: [
    ["tool", "Read", "packages/engine/src/runs/slots.ts", "142 lines"],
    ["tool", "Read", "packages/cli/test/status.test.ts", "188 lines"],
    ["text", "The new test covers a run that waits for a slot. Checking that paused runs no longer count."],
    ["tool", "Bash", "pnpm vitest run status", "18 passed"],
    ["text", "Both earlier blockers are fixed. Checking the JSON shape once more."],
  ],
  generic: [
    ["tool", "Read", "src/webhooks/handlers/invoice-paid.ts", "120 lines"],
    ["text", "Moving the invoice-paid handler to the queue. Its retry policy keeps 5 tries."],
    ["tool", "Grep", '"pollWebhooks"  src', "5 matches in 4 files"],
    ["tool", "Edit", "src/webhooks/handlers/invoice-paid.ts", "+18 -31"],
    ["tool", "Bash", "pnpm vitest run webhooks", "48 passed"],
    ["text", "The handler runs from the queue now. The tests pass."],
  ],
};
const poolAct = (p) => p[0] === "tool" ? T(p[1], p[2], p[3]) : X(p[1]);

const MD_NOTES = "## What's new in 2.4\n\n- **Monthly or yearly.** The pricing page has a toggle, and the yearly price shows what you save. (#388)\n- **Faster search.** Results show as you type, in under 100 ms. (#391)\n- **Team invites by link.** Send one link instead of one email per person. (#402)\n\n## Fixes\n\n- The footer links on the blog work again. (#394)\n- Dark mode keeps code blocks readable. (#397)\n- The sign-up form remembers what you typed after an error. (#399)\n- Prices round to cents on every page. (#405)";
const FLAKY_ERR = (n, i) => "FAIL  packages/engine/test/parallel.test.ts > parallel > resumes after a pause\nAssertionError: expected 'paused' to be 'running'\n\n- Expected: \"running\"\n+ Received: \"paused\"\n\n    at Object.<anonymous> (packages/engine/test/parallel.test.ts:212:31)\n    at runTest (node_modules/vitest/dist/runner.js:1180:11)\n    at runSuite (node_modules/vitest/dist/runner.js:1312:15)\n    at runFiles (node_modules/vitest/dist/runner.js:1366:5)\n    at startTests (node_modules/vitest/dist/runner.js:1375:3)\n\n Test Files  1 failed (1)\n      Tests  " + n + " failed | " + (20 - n) + " passed (20)\n   Start at  " + i;

/* 500 lines of activity for one long step */
function longActs() {
  const out = [P("Implement this ticket:\nMove the tests to vitest 4")];
  const files = [];
  ["engine", "cli", "harnesses"].forEach((p) => { for (let i = 1; i <= 40; i++) files.push("packages/" + p + "/test/" + ["runs", "steps", "places", "tell", "gate", "retry", "parallel", "pipeline", "pause", "resume"][i % 10] + "-" + i + ".test.ts"); });
  out.push(X("vitest 4 drops the old workspace file and renames two matchers. I'll update the config first, then each test file."));
  out.push(T("Read", "vitest.workspace.ts", "18 lines"), T("Edit", "vitest.config.ts", "+22 -4"), T("Bash", "pnpm add -D vitest@^4", "done"));
  let k = 0;
  while (out.length < 494) {
    const f = files[k % files.length];
    out.push(T("Read", f, (40 + (k * 37) % 260) + " lines"));
    out.push(T("Edit", f, "+" + (1 + k % 4) + " -" + (1 + k % 3)));
    if (k % 6 === 5) out.push(T("Bash", "pnpm vitest run " + f.split("/").pop(), (8 + k % 20) + " passed"));
    if (k % 25 === 24) out.push(X("Done with " + (k + 1) + " files. toMatchObject now checks extra keys, so a few fixtures needed trimming."));
    k++;
  }
  out.push(T("Bash", "pnpm test", "1,284 passed"), X("All 120 test files run on vitest 4. The old workspace file is gone. 1,284 tests pass."));
  return out;
}

/* the sample runs */
const SPECS = [
  { id: "r-7q4m2a", wf: "ticket", project: "orchestrator", label: "Add a --json flag to sous list", by: "Claude Code, for you", status: "question", ago: 11 * M + 32 * S,
    inputs: { ticket: "Add a --json flag to sous list", rounds: 3 },
    tree: [
      A("implementer", "implementer", { s: "waiting", d: 9 * M + 12 * S, tok: 61200, keep: true, acts: [
        T("Read", "packages/cli/src/commands/list.ts", "212 lines"),
        T("Grep", '"--json"  packages/cli/src', "14 matches in 9 files"),
        X("Every other command prints one object with notes and next. sous list should do the same, holding the rows under runs."),
        T("Read", "packages/cli/src/format.ts", "88 lines"),
        T("Edit", "packages/cli/test/list.test.ts", "+34 -0"),
        T("Bash", "pnpm vitest run list", "1 failed | 11 passed"),
        X("The new test fails as it should. One choice is left before the change."),
        Q("Should sous list --json show nested runs as rows of their own, or only under their parent run?")],
        ask: { id: "q-3k9d", kind: "input", text: "Should sous list --json show nested runs as rows of their own, or only under their parent run?" } }),
      Gate("review", 3, [], { s: "queued" }),
      C("sh", "tests", "pnpm test", { s: "queued" }),
      C("sh", "commit", 'git add -A && git commit -m "Add a --json flag to sous list"', { s: "queued" }),
    ] },
  { id: "r-2c8f1d", wf: "factory", project: "billing", label: "team BILL", by: "you, from the terminal", status: "question", ago: 6 * M + 10 * S,
    inputs: { team: "BILL", limit: 5 },
    tree: [
      C("sh", "fetch", "node scripts/tickets.js BILL", { d: 2 * S, out: "BILL-212  Round invoice totals to cents\nBILL-219  Retry failed webhooks with backoff\nBILL-220  Make billing faster" }),
      A("triager", "triager", { d: 3 * M + 10 * S, tok: 22100, acts: [
        T("mcp linear", "get_issue BILL-212", "Round invoice totals to cents. Totals show 3 decimals on PDF invoices."),
        T("mcp linear", "get_issue BILL-219", "Retry failed webhooks with backoff, 5 tries, then alert."),
        T("mcp linear", "get_issue BILL-220", "Make billing faster."),
        X("BILL-212 and BILL-219 say what to change and how to check it. BILL-220 names no page and no target time.")],
        out: '{ "clear": ["BILL-212", "BILL-219"], "vague": ["BILL-220"] }' }),
      Ask("Build these?", { s: "waiting", d: 0, ask: { id: "q-7v2n", kind: "select", text: "The triager found 2 clear tickets. Build these?", choices: ["Build all", "Only BILL-212", "Only BILL-219", "Build none"] } }),
      Pipe("pipeline", [], { s: "queued" }),
    ] },
  { id: "r-9h3t6e", wf: "triage-bugs", project: "billing", label: "team BILL", by: "schedule, weekdays 08:00", status: "question", ago: 44 * M,
    inputs: { team: "BILL" },
    tree: [
      A("triage", "triager", { d: 6 * M + 40 * S, tok: 31200, mcp: ["linear"], acts: [
        T("mcp linear", "list_issues team:BILL state:new", "9 issues"),
        T("mcp linear", "update_issue BILL-231 labels:+bug +urgent", "done"),
        T("mcp linear", "update_issue BILL-233 labels:+bug +urgent", "done"),
        T("mcp linear", "update_issue BILL-236 labels:+bug +urgent", "done"),
        T("mcp linear", "update_issue BILL-237 labels:+bug", "done"),
        X("Labeled 9 new bugs. 3 are urgent: BILL-231, BILL-233 and BILL-236.")] }),
      Ck("Plan the urgent ones now?", { s: "waiting", d: 0, ask: { id: "q-5r8w", kind: "confirm", text: "Plan the urgent ones now?", detail: "The triager labeled 9 new bugs. 3 are urgent: BILL-231, BILL-233 and BILL-236." } }),
      A("plan", "planner", { s: "queued", mcp: ["linear", "postgres"] }),
      Ch("pick what to run", { s: "queued" }),
    ] },
  { id: "r-4p7k8b", wf: "release-notes", project: "site", label: "since v2.3.0", by: "you, from the terminal", status: "breakpoint", ago: 9 * M,
    inputs: { since: "v2.3.0" },
    tree: [
      C("sh", "log", "git log v2.3.0..HEAD --merges --oneline", { d: 1 * S, out: "a41c2e0 Merge #388 pricing toggle\n9be1f70 Merge #391 faster search\n55d02aa Merge #394 fix footer links\n... 9 more" }),
      Bp("Notes look right?", [A("draft", "writer", { d: 1 * M + 52 * S, tok: 14800, acts: [
        T("Bash", "gh pr view 388 --json title,body", "Monthly and yearly prices on one page"),
        T("Bash", "gh pr view 391 --json title,body", "Search answers in under 100 ms"),
        T("Bash", "gh pr view 402 --json title,body", "Invite a team with one link"),
        X("Draft ready. 3 changes people will notice, 4 fixes, 5 internal changes left out.")], out: MD_NOTES })],
        { s: "waiting", show: MD_NOTES, ask: { id: "q-8b1x", kind: "breakpoint", text: "Notes look right?" } }),
      C("js", "changelog", "fs.appendFileSync('CHANGELOG.md', input)", { s: "queued" }),
    ] },
  { id: "r-6w1n5c", wf: "factory", project: "billing", label: "team PAY", by: "you, from the terminal", status: "question", ago: 24 * M,
    inputs: { team: "PAY", limit: 5 },
    tree: [
      C("sh", "fetch", "node scripts/tickets.js PAY", { d: 2 * S, out: "PAY-88  Refund partial payments\nPAY-91  Show failed payments in the dashboard\nPAY-94  Retry card payments after a soft decline" }),
      A("triager", "triager", { d: 2 * M + 30 * S, tok: 19400, acts: [T("mcp linear", "list_issues team:PAY state:todo", "3 issues"), X("All 3 tickets are clear.")], out: '{ "clear": ["PAY-88", "PAY-91", "PAY-94"], "vague": [] }' }),
      Ask("Build these?", { d: 3 * M, answer: "Build all", ask: { kind: "select", text: "The triager found 3 clear tickets. Build these?", choices: ["Build all", "Only PAY-88", "Only PAY-91", "Only PAY-94", "Build none"] } }),
      Pipe("pipeline", [
        Wf("ticket A", "ticket", [
          A("implementer", "implementer", { s: "waiting", d: 8 * M + 20 * S, tok: 40100, keep: true, acts: [T("Read", "src/refunds/partial.ts", "77 lines"), T("Read", "src/invoices/state.ts", "120 lines"), X("Two readings of the ticket fit."), Q("Should a partial refund reopen the invoice, or stay a separate credit note?")],
            ask: { id: "q-1a4c", kind: "input", text: "Should a partial refund reopen the invoice, or stay a separate credit note?" } }),
          Gate("review", 3, [], { s: "queued" }), C("sh", "tests", "pnpm test", { s: "queued" }), C("sh", "commit", "git commit", { s: "queued" })], { inputs: { ticket: "PAY-88" } }),
        Wf("ticket B", "ticket", [
          A("implementer", "implementer", { s: "waiting", d: 6 * M + 5 * S, tok: 33800, keep: true, acts: [T("Read", "src/dashboard/Payments.tsx", "212 lines"), Q("The dashboard has no failed state yet. Add a filter tab, or show failed payments inline with a red label?")],
            ask: { id: "q-2b7f", kind: "input", text: "The dashboard has no failed state yet. Add a filter tab, or show failed payments inline with a red label?" } }),
          Gate("review", 3, [], { s: "queued" }), C("sh", "tests", "pnpm test", { s: "queued" }), C("sh", "commit", "git commit", { s: "queued" })], { inputs: { ticket: "PAY-91" } }),
        Wf("ticket C", "ticket", [
          A("implementer", "implementer", { s: "waiting", d: 4 * M + 48 * S, tok: 25100, keep: true, acts: [T("Read", "src/payments/retry.ts", "64 lines"), T("Grep", '"soft_decline"  src', "3 matches in 2 files"), Q("How many retries after a soft decline: the 3 the ticket says, or the 4 the card network allows?")],
            ask: { id: "q-3c2h", kind: "input", text: "How many retries after a soft decline: the 3 the ticket says, or the 4 the card network allows?" } }),
          Gate("review", 3, [], { s: "queued" }), C("sh", "tests", "pnpm test", { s: "queued" }), C("sh", "commit", "git commit", { s: "queued" })], { inputs: { ticket: "PAY-94" } }),
      ]),
    ] },
  { id: "r-8d2v7f", wf: "fix-flaky", project: "orchestrator", label: "engine: parallel resumes after a pause", by: "you, from the terminal", status: "failed", ago: 2 * H + 10 * M,
    inputs: { test: "packages/engine/test/parallel.test.ts", tries: 20 },
    notice: "verify failed on all 3 tries. Resume runs it again from that step, with the steps before it kept.",
    tree: [
      C("run", "reproduce", "scripts/flaky.sh packages/engine/test/parallel.test.ts 20", { d: 48 * S, out: "failed 3 of 20\nresumes after a pause: expected 'paused' to be 'running'" }),
      A("investigate", "investigator", { d: 7 * M + 3 * S, tok: 48200, acts: [
        T("Read", "packages/engine/src/parallel.ts", "301 lines"),
        T("Bash", "pnpm vitest run parallel --repeat 50", "6 failed | 44 passed"),
        X("The resume reads the step state before the pause has written it. A slow disk makes the window wider."),
        X("Cause: resume() does not await the pause's final write. Smallest fix: await pausing before reading the state.")] }),
      Retry("fix", 2, [
        { ok: false, v: "check exited 1: 2 of 5 failed", steps: [
          A("fix", "implementer", { d: 5 * M + 40 * S, tok: 41100, acts: [T("Edit", "packages/engine/src/parallel.ts", "+4 -1"), X("resume() now awaits the pending pause write.")] }),
          C("sh", "check", "pnpm vitest run packages/engine/test/parallel.test.ts --repeat 5", { d: 38 * S, exit: 1, out: "Tests  2 failed | 3 passed (5)" })] },
        { ok: true, v: "check exited 0: 5 of 5 passed", steps: [
          A("fix", "implementer", { d: 3 * M + 20 * S, tok: 22000, acts: [T("Read", "packages/engine/src/pause.ts", "96 lines"), T("Edit", "packages/engine/src/pause.ts", "+6 -2"), X("The pause also wrote its state after a timer. It now writes before it resolves.")] }),
          C("sh", "check", "pnpm vitest run packages/engine/test/parallel.test.ts --repeat 5", { d: 41 * S, out: "Tests  5 passed (5)" })] },
      ]),
      C("sh", "verify", "pnpm vitest run packages/engine/test/parallel.test.ts --repeat 20", { s: "failed", retries: 2, exit: 1,
        err: "The command exited with 1 on all 3 tries.",
        tries: [{ s: "failed", d: 1 * M + 50 * S, exit: 1, stderr: FLAKY_ERR(1, "14:02:11") }, { s: "failed", d: 1 * M + 46 * S, exit: 1, stderr: FLAKY_ERR(2, "14:04:03") }, { s: "failed", d: 1 * M + 52 * S, exit: 1, stderr: FLAKY_ERR(1, "14:05:52") }] }),
    ] },
  { id: "r-1k6s3g", wf: "ticket", project: "site", label: "Dark mode for the pricing page", by: "Claude Code, for you", status: "running", ago: 18 * M,
    inputs: { ticket: "Dark mode for the pricing page", rounds: 3 },
    tree: [
      A("implementer", "implementer", { d: 11 * M, tok: 52000, keep: true, acts: [
        T("Read", "src/pages/pricing.tsx", "184 lines"),
        T("Grep", '"#fff"  src/pages src/components/pricing', "23 matches in 6 files"),
        X("The pricing cards use hard-coded colors. I'll move them to the theme tokens the rest of the site uses."),
        T("Edit", "src/styles/tokens.css", "+18 -2"),
        TELL("Keep the light colors exactly as they are today."),
        X("Understood. Light mode keeps its values. Only the dark tokens are new."),
        T("Edit", "src/components/pricing/Card.tsx", "+9 -9"),
        X("The cards read their colors from the tokens. Light values are unchanged.")] }),
      Gate("review", 3, [
        { ok: false, v: "Not approved: the toggle keeps a hard-coded white track, and no test covers dark mode.", steps: [
          A("reviewer", "reviewer", { d: 2 * M + 40 * S, tok: 9800, acts: [T("Read", "src/components/pricing/Toggle.tsx", "77 lines"), T("Grep", '"dark"  test', "0 matches"), X("Not approved: the toggle keeps a hard-coded white track, and no test covers dark mode.")] })] },
        { steps: [
          A("address review", "implementer", { s: "running", cont: true, live: "darkmode", poolI: 2, tok: 6100, acts: [poolAct(POOLS.darkmode[0]), poolAct(POOLS.darkmode[1])] }),
          A("reviewer", "reviewer", { s: "queued" })] },
      ]),
      C("sh", "tests", "pnpm test", { s: "queued" }),
      C("sh", "commit", 'git add -A && git commit -m "Dark mode for the pricing page"', { s: "queued" }),
    ] },
  { id: "r-5t9b4h", wf: "ticket", project: "orchestrator", label: "Show the queue position in sous status", by: "you, from the terminal", status: "running", ago: 21 * M,
    inputs: { ticket: "Show the queue position in sous status", rounds: 3 },
    tree: [
      A("implementer", "implementer", { d: 7 * M + 20 * S, tok: 38800, keep: true, acts: [T("Read", "packages/cli/src/commands/status.ts", "160 lines"), T("Edit", "packages/cli/src/commands/status.ts", "+22 -3"), X("sous status shows each waiting run's place in the queue.")] }),
      Gate("review", 3, [
        { ok: false, v: "Not approved: the position counts paused runs, which never take a slot.", steps: [A("reviewer", "reviewer", { d: 2 * M, tok: 8800, acts: [X("Not approved: the position counts paused runs, which never take a slot.")] })] },
        { ok: false, v: "Not approved: no test covers a run that waits for a slot.", steps: [
          A("address review", "implementer", { d: 3 * M, tok: 14100, cont: true, acts: [T("Edit", "packages/engine/src/runs/slots.ts", "+5 -2"), X("Paused runs no longer count.")] }),
          A("reviewer", "reviewer", { d: 1 * M + 50 * S, tok: 7900, acts: [X("Not approved: no test covers a run that waits for a slot.")] })] },
        { steps: [
          A("address review", "implementer", { d: 2 * M + 30 * S, tok: 11800, cont: true, acts: [T("Edit", "packages/cli/test/status.test.ts", "+38 -0"), T("Bash", "pnpm vitest run status", "18 passed")] }),
          A("reviewer", "reviewer", { s: "running", live: "queue", tok: 3100, acts: [T("Read", "packages/cli/src/commands/status.ts", "171 lines")] })] },
      ]),
      C("sh", "tests", "pnpm test", { s: "queued" }),
      C("sh", "commit", 'git add -A && git commit -m "Show the queue position in sous status"', { s: "queued" }),
    ] },
  { id: "r-3m8x2j", wf: "review-pr", project: "billing", label: "PR 418", by: "Codex, for you", status: "running", ago: 5 * M + 40 * S,
    inputs: { pr: 418 },
    tree: [
      C("sh", "diff", "gh pr diff 418", { d: 3 * S, out: " src/invoices/total.ts   | 41 ++++---\n src/webhooks/retry.ts   | 88 +++++++++++\n 2 files changed" }),
      Par("parallel", [
        A("reviewer", "reviewer", { s: "running", live: "review", tok: 8400, acts: [
          T("Read", "src/invoices/total.ts", "96 lines"),
          X("Rounding now happens once, at the end. That fixes the 3-decimal totals."),
          TELL("Also check the rounding in credit notes.", "pending"),
          T("Read", "test/invoices/total.test.ts", "140 lines")] }),
        A("security", "security-reviewer", { s: "running", q: 5 * M + 31 * S, tok: 0, acts: [] }),
      ]),
      Bp("Post this review?", [A("comment", "writer", { s: "queued" })], { s: "queued" }),
      C("sh", "post", "gh pr comment 418 --body-file -", { s: "queued" }),
    ] },
  { id: "r-0z5q9k", wf: "migrate-billing-webhooks-to-the-new-queue", project: "billing", label: "Backfill every failed webhook event since the March outage, then move the handlers to the new queue", by: "you, from the terminal", status: "running", ago: 9 * M,
    inputs: { since: "2026-03-14" },
    tree: [
      C("sh", "inventory", "node scripts/list-webhook-handlers.js", { d: 2 * S, out: "invoice-paid\ninvoice-failed\nsubscription-renewed\nrefund-created" }),
      A("migrate", "implementer", { s: "running", live: "generic", tok: 21000, acts: [T("Read", "src/webhooks/poller.ts", "212 lines"), X("Four handlers to move. Starting with invoice-paid, the busiest.")] }),
      C("sh", "backfill", "node scripts/backfill-webhooks.js --since 2026-03-14", { s: "queued" }),
      C("sh", "tests", "pnpm test", { s: "queued" }),
    ] },
  { id: "r-4b2c7m", wf: "docs-sync", project: "docs", label: "ref main", by: "you, from the terminal", status: "paused", ago: 1 * H + 5 * M,
    inputs: { ref: "main" }, pause: { reason: "usage_limit", resumesAt: NOW + 34 * M },
    tree: [
      C("sh", "changes", "git diff main...HEAD --stat", { d: 1 * S, out: " packages/cli/src/commands/tell.ts | 120 ++++" }),
      A("update docs", "docs-writer", { s: "paused", d: 22 * M, tok: 54100, acts: [
        T("Read", "guide/steer.md", "64 lines"),
        T("Edit", "guide/steer.md", "+12 -3"),
        FAIL("The account default reached its usage limit. It resets at {resume}.")] }),
      A("review", "reviewer", { s: "queued" }),
    ] },
  { id: "r-7e3d1n", wf: "deps-update", project: "site", label: "scope minor", by: "you, from the terminal", status: "paused", ago: 48 * M,
    inputs: { scope: "minor" }, pause: { reason: "budget", budget: 200000 },
    tree: [
      C("sh", "outdated", "pnpm outdated --json --minor", { d: 3 * S, out: '{ "react-router": "7.6.2 to 7.9.1",\n  "vite": "6.3.5 to 6.4.0",\n  "zod": "4.1.0 to 4.3.2" }' }),
      Pipe("pipeline", [
        Lane("react-router", [
          A("upgrade react-router", "codex-fixer", { d: 12 * M, tok: 88200, acts: [T("shell", "pnpm add react-router@^7.9", "done"), T("shell", "pnpm vitest run --changed", "3 failed | 41 passed"), T("apply_patch", "src/routes.tsx", "+12 -9"), X("Moved the loaders to the new data API. The tests pass.")] }),
          C("sh", "test react-router", "pnpm vitest run --changed", { d: 40 * S, out: "Tests  44 passed (44)" })]),
        Lane("vite", [
          A("upgrade vite", "codex-fixer", { d: 19 * M, tok: 94100, acts: [T("shell", "pnpm add -D vite@^6.4", "done"), T("shell", "pnpm build", "1 warning"), T("apply_patch", "vite.config.ts", "+3 -3"), X("The build is clean. One option was renamed.")] }),
          C("sh", "test vite", "pnpm vitest run --changed", { d: 52 * S, out: "Tests  44 passed (44)" })]),
        Lane("zod", [
          A("upgrade zod", "codex-fixer", { s: "paused", q: 12 * M + 41 * S, d: 9 * M + 10 * S, tok: 19500, acts: [T("shell", "pnpm add zod@^4.3", "done"), NOTE("The run reached its budget of 200k tokens. The step stopped.")] }),
          C("sh", "test zod", "pnpm vitest run --changed", { s: "queued" })]),
      ]),
      C("sh", "tests", "pnpm test", { s: "queued" }),
    ] },
  { id: "r-2u8w6p", wf: "triage-bugs", project: "billing", label: "team PAY", by: "schedule, weekdays 08:00", status: "paused", ago: 1 * D + 2 * H,
    inputs: { team: "PAY" }, pause: { reason: "auth_required" },
    tree: [
      A("triage", "triager", { s: "paused", d: 4 * S, tok: 0, mcp: ["linear"], acts: [FAIL("Claude Code is not logged in. Run claude and log in, then resume.")] }),
      Ck("Plan the urgent ones now?", { s: "queued" }),
      A("plan", "planner", { s: "queued" }),
      Ch("pick what to run", { s: "queued" }),
    ] },
  { id: "r-9j1r4q", wf: "fix-flaky", project: "site", label: "search: results update after typing stops", by: "you, from the terminal", status: "paused", ago: 2 * H + 6 * M,
    inputs: { test: "src/search/debounce.test.ts", tries: 20 }, pause: { reason: "time_limit", limit: "2h" },
    tree: [
      C("run", "reproduce", "scripts/flaky.sh src/search/debounce.test.ts 20", { d: 1 * M + 4 * S, out: "failed 5 of 20\nupdates after typing stops: expected 1 call, got 2" }),
      A("investigate", "investigator", { d: 38 * M, tok: 92400, acts: [T("Read", "src/search/useDebounce.ts", "41 lines"), X("The test uses real timers and a 300ms debounce. Under load the second keystroke lands after the timer fires.")] }),
      Retry("fix", 2, [
        { ok: false, v: "check exited 1: 1 of 5 failed", steps: [
          A("fix", "implementer", { d: 41 * M, tok: 88100, acts: [T("Edit", "src/search/debounce.test.ts", "+12 -4"), X("Switched the test to fake timers.")] }),
          C("sh", "check", "pnpm vitest run src/search/debounce.test.ts --repeat 5", { d: 1 * M + 2 * S, exit: 1, out: "Tests  1 failed | 4 passed (5)" })] },
        { steps: [
          A("fix", "implementer", { s: "paused", d: 37 * M + 54 * S, tok: 71300, acts: [T("Read", "src/search/useDebounce.ts", "41 lines"), X("The hook also reads Date.now(). Mocking it too."), NOTE("The workflow's timeout of 2h ran out. The step stopped.")] }),
          C("sh", "check", "pnpm vitest run src/search/debounce.test.ts --repeat 5", { s: "queued" })] },
      ]),
      C("sh", "verify", "pnpm vitest run src/search/debounce.test.ts --repeat 20", { s: "queued" }),
    ] },
  { id: "r-6f4k2s", wf: "release-notes", project: "billing", label: "since v1.8.0", by: "you, from the terminal", status: "stopped", ago: 2 * D + 3 * H,
    inputs: { since: "v1.8.0" },
    notice: 'You stopped it at the breakpoint "Notes look right?". Steps after it did not run.',
    tree: [
      C("sh", "log", "git log v1.8.0..HEAD --merges --oneline", { d: 1 * S, out: "0c1d9e2 Merge #201 invoice export\n7e3f114 Merge #204 tax rates by region\n... 5 more" }),
      Bp("Notes look right?", [A("draft", "writer", { d: 2 * M, tok: 15200, acts: [X("Draft ready. 2 changes, 3 fixes.")], out: "## What's new in 1.9\n\n- **Invoice export.** Download a month of invoices as one CSV. (#201)\n- **Tax by region.** Rates follow the customer's region. (#204)" })],
        { s: "stopped", waited: 7 * M, show: "## What's new in 1.9\n\n- **Invoice export.** Download a month of invoices as one CSV. (#201)\n- **Tax by region.** Rates follow the customer's region. (#204)" }),
      C("js", "changelog", "fs.appendFileSync('CHANGELOG.md', input)", { s: "skipped" }),
    ] },
  { id: "r-8c5h3t", wf: "ticket", project: "docs", label: "Fix broken links in the guide", by: "you, from the terminal", status: "done", ago: 3 * H + 20 * M,
    inputs: { ticket: "Fix broken links in the guide", rounds: 3 },
    result: "Fixed 14 broken links in the guide: 9 pointed at renamed sections, 5 at the old docs site. Added a link check to pnpm test.",
    tree: [
      A("implementer", "implementer", { d: 8 * M + 10 * S, tok: 38400, keep: true, acts: [T("Bash", "pnpm exec lychee guide", "14 broken links"), T("Edit", "guide/start.md", "+9 -9"), T("Edit", "guide/steer.md", "+5 -5"), X("Fixed the 14 links. Added lychee to pnpm test.")] }),
      Gate("review", 3, [
        { ok: false, v: "Not approved: 2 links still point at the old docs site.", steps: [A("reviewer", "reviewer", { d: 1 * M + 50 * S, tok: 8100, acts: [T("Bash", "pnpm exec lychee guide", "2 broken links"), X("Not approved: 2 links still point at the old docs site.")] })] },
        { ok: true, v: "Approved.", steps: [
          A("address review", "implementer", { d: 2 * M + 10 * S, tok: 9800, cont: true, acts: [T("Grep", '"docs.old"  guide', "2 matches in 2 files"), T("Edit", "guide/install.md", "+2 -2"), X("Both links now point at the new site.")] }),
          A("reviewer", "reviewer", { d: 1 * M + 20 * S, tok: 6200, acts: [T("Bash", "pnpm exec lychee guide", "0 broken links"), X("Approved.")] })] },
      ]),
      C("sh", "tests", "pnpm test", { d: 42 * S, out: "Tests  31 passed (31)" }),
      C("sh", "commit", 'git add -A && git commit -m "Fix broken links in the guide"', { d: 1 * S, out: "1 file changed, 16 insertions(+), 16 deletions(-)" }),
    ] },
  { id: "r-3n7p5v", wf: "review-pr", project: "orchestrator", label: "PR 520", by: "Claude Code, for you", status: "done", ago: 7 * H + 15 * M,
    inputs: { pr: 520 },
    notice: "1 of 2 parallel branches failed. parallel() gave null for security, and the run went on without it.",
    result: "Posted the review on PR 520 from the reviewer alone. The security review failed and is not in the comment.",
    tree: [
      C("sh", "diff", "gh pr diff 520", { d: 2 * S, out: " packages/engine/src/runs/tell.ts | 52 +++++---\n 1 file changed" }),
      Par("parallel", [
        A("reviewer", "reviewer", { d: 2 * M + 40 * S, tok: 12100, acts: [T("Read", "packages/engine/src/runs/tell.ts", "201 lines"), X("Nothing blocks. One name could be clearer.")] }),
        A("security", "security-reviewer", { s: "failed", d: 1 * M + 12 * S, tok: 9400, acts: [T("Read", "packages/engine/src/runs/tell.ts", "201 lines"), T("mcp github", "search_code tellResult repo:orchestrator", "error")],
          err: "The agent step failed: mcp github returned 401 Unauthorized. The token in GITHUB_TOKEN has expired.",
          stderr: "McpError: 401 Unauthorized\n    at HttpTransport.send (harnesses/src/mcp/http.ts:88:13)\n    at async callTool (harnesses/src/mcp/client.ts:142:5)\n    at async ClaudeCodeStep.turn (harnesses/src/claude/step.ts:311:22)" }),
      ]),
      Bp("Post this review?", [A("comment", "writer", { d: 50 * S, tok: 3900, acts: [X("One comment from the reviewer's review.")] })], { s: "approved", waited: 4 * M }),
      C("sh", "post", "gh pr comment 520 --body-file -", { d: 2 * S, out: "posted a comment on PR 520" }),
    ] },
  { id: "r-1v9m8w", wf: "review-pr", project: "orchestrator", label: "PR 512", by: "Claude Code, for you", status: "done", ago: 5 * H + 10 * M,
    inputs: { pr: 512 },
    result: "Posted the review on PR 512: one blocker (a missing test for --call), two suggestions.",
    tree: [
      C("sh", "diff", "gh pr diff 512", { d: 2 * S, out: " packages/cli/src/commands/run.ts | 64 ++++++---\n 1 file changed" }),
      Par("parallel", [
        A("reviewer", "reviewer", { d: 2 * M + 10 * S, tok: 11200, acts: [T("Read", "packages/cli/src/commands/run.ts", "240 lines"), X("Blocker: --call has no test. Two names could be clearer.")] }),
        A("security", "security-reviewer", { d: 3 * M + 30 * S, tok: 19800, acts: [T("Grep", '"exec("  packages/cli/src', "0 matches"), X("Nothing found. The new flag reaches no shell.")] }),
      ]),
      Bp("Post this review?", [A("comment", "writer", { d: 1 * M, tok: 4100, acts: [X("One comment: the blocker first, then two suggestions.")] })], { s: "approved", waited: 3 * M }),
      C("sh", "post", "gh pr comment 512 --body-file -", { d: 2 * S, out: "posted a comment on PR 512" }),
    ] },
  { id: "r-5a3e9x", wf: "factory", project: "billing", label: "team BILL, nightly", by: "schedule, nightly 02:00", status: "done", ago: 15 * H + 10 * M,
    inputs: { team: "BILL", limit: 5 },
    result: "Built BILL-207 and BILL-209, each on a branch of its own. Skipped BILL-210, which was vague.",
    tree: [
      C("sh", "fetch", "node scripts/tickets.js BILL", { d: 2 * S, out: "BILL-207  Add the VAT number to invoices\nBILL-209  Email receipts as PDF\nBILL-210  Improve checkout" }),
      A("triager", "triager", { d: 2 * M + 40 * S, tok: 18900, acts: [T("mcp linear", "get_issue BILL-207", "Show the VAT number under the address."), T("mcp linear", "get_issue BILL-209", "Attach a PDF receipt to the email."), X("BILL-207 and BILL-209 are clear. BILL-210 names no change to make.")] }),
      Ask("Build these?", { d: 9 * M, answer: "Build all", by: "you, from the view", ask: { kind: "select", text: "The triager found 2 clear tickets. Build these?", choices: ["Build all", "Only BILL-207", "Only BILL-209", "Build none"] } }),
      Pipe("pipeline", [
        Wf("ticket A", "ticket", [
          A("implementer", "implementer", { d: 14 * M, tok: 61000, keep: true, acts: [T("Read", "src/invoices/pdf.ts", "180 lines"), T("Edit", "src/invoices/pdf.ts", "+14 -2"), X("The VAT number shows under the address.")] }),
          Gate("review", 3, [{ ok: true, v: "Approved.", steps: [A("reviewer", "reviewer", { d: 2 * M + 5 * S, tok: 8300, acts: [X("Approved.")] })] }]),
          C("sh", "tests", "pnpm test", { d: 51 * S, out: "Tests  214 passed (214)" }),
          C("sh", "commit", 'git add -A && git commit -m "BILL-207"', { d: 1 * S, out: "2 files changed" })], { inputs: { ticket: "BILL-207" } }),
        Wf("ticket B", "ticket", [
          A("implementer", "implementer", { d: 11 * M, tok: 48200, keep: true, acts: [T("Read", "src/email/receipt.ts", "92 lines"), T("Edit", "src/email/receipt.ts", "+31 -4"), X("Receipts go out with a PDF attached.")] }),
          Gate("review", 3, [
            { ok: false, v: "Not approved: the PDF is built twice per email.", steps: [A("reviewer", "reviewer", { d: 1 * M + 40 * S, tok: 7100, acts: [X("Not approved: the PDF is built twice per email.")] })] },
            { ok: true, v: "Approved.", steps: [A("address review", "implementer", { d: 2 * M, tok: 9100, cont: true, acts: [X("The PDF is built once.")] }), A("reviewer", "reviewer", { d: 1 * M + 10 * S, tok: 5200, acts: [X("Approved.")] })] }]),
          C("sh", "tests", "pnpm test", { d: 49 * S, out: "Tests  216 passed (216)" }),
          C("sh", "commit", 'git add -A && git commit -m "BILL-209"', { d: 1 * S, out: "3 files changed" })], { inputs: { ticket: "BILL-209" } }),
      ]),
    ] },
  { id: "r-7g2b6y", wf: "ticket", project: "site", label: "Move the tests to vitest 4", by: "you, from the terminal", status: "done", ago: 1 * D + 2 * H,
    inputs: { ticket: "Move the tests to vitest 4", rounds: 3 },
    result: "All 120 test files run on vitest 4. 1,284 tests pass.",
    tree: [
      A("implementer", "implementer", { d: 48 * M + 20 * S, tok: 412000, keep: true, acts: longActs(), noPrompt: true }),
      Gate("review", 3, [{ ok: true, v: "Approved.", steps: [A("reviewer", "reviewer", { d: 4 * M + 10 * S, tok: 21200, acts: [T("Bash", "pnpm test", "1,284 passed"), X("Approved.")] })] }]),
      C("sh", "tests", "pnpm test", { d: 2 * M + 12 * S, out: "Tests  1284 passed (1284)" }),
      C("sh", "commit", 'git add -A && git commit -m "Move the tests to vitest 4"', { d: 2 * S, out: "124 files changed, 1980 insertions(+), 1702 deletions(-)" }),
    ] },
  { id: "r-4w8c1z", wf: "docs-sync", project: "site", label: "ref main", by: "you, from the terminal", status: "done", ago: 1 * D + 6 * H,
    inputs: { ref: "main" }, result: "Updated 3 pages for the new pricing toggle.",
    tree: [
      C("sh", "changes", "git diff main...HEAD --stat", { d: 1 * S, out: " src/pages/pricing.tsx | 48 ++++--\n src/components/pricing/Toggle.tsx | 61 +++++\n 2 files changed" }),
      A("update docs", "docs-writer", { d: 6 * M, tok: 27100, acts: [T("Read", "content/pricing.md", "52 lines"), T("Edit", "content/pricing.md", "+14 -4"), X("Updated 3 pages for the new pricing toggle.")] }),
      A("review", "reviewer", { d: 1 * M + 40 * S, tok: 7300, acts: [X("The pages read well and match the code.")] }),
    ] },
  { id: "r-9s6t3a", wf: "ticket", project: "billing", label: "Round invoice totals to cents", by: "Claude Code, for you", status: "done", ago: 2 * D + 20 * H,
    inputs: { ticket: "Round invoice totals to cents", rounds: 3 },
    result: "Totals round once, at the end, to cents. Added tests for 3-decimal line items.",
    tree: [
      A("implementer", "implementer", { d: 9 * M + 40 * S, tok: 44100, keep: true, acts: [T("Read", "src/invoices/total.ts", "96 lines"), T("Edit", "test/invoices/total.test.ts", "+28 -0"), T("Edit", "src/invoices/total.ts", "+11 -14"), T("Bash", "pnpm vitest run invoices", "12 passed"), X("Totals now round once, at the end.")] }),
      Gate("review", 3, [
        { ok: false, v: "Not approved: credit notes still round per line.", steps: [A("reviewer", "reviewer", { d: 2 * M, tok: 9900, acts: [T("Grep", '"roundCents"  src', "4 matches in 3 files"), X("Not approved: credit notes still round per line.")] })] },
        { ok: true, v: "Approved.", steps: [
          A("address review", "implementer", { d: 3 * M + 10 * S, tok: 14200, cont: true, acts: [T("Edit", "src/invoices/credit.ts", "+4 -6"), T("Bash", "pnpm vitest run invoices", "15 passed"), X("Credit notes call total() now.")] }),
          A("reviewer", "reviewer", { d: 1 * M + 30 * S, tok: 7600, acts: [T("Read", "src/invoices/credit.ts", "61 lines"), X("Approved.")] })] },
      ]),
      C("sh", "tests", "pnpm test", { d: 48 * S, out: "Tests  212 passed (212)" }),
      C("sh", "commit", 'git add -A && git commit -m "Round invoice totals to cents"', { d: 1 * S, out: "3 files changed, 43 insertions(+), 20 deletions(-)" }),
    ] },
  { id: "r-2h7n4b", wf: "fix-flaky", project: "site", label: "checkout e2e: coupon field", by: "you, from the terminal", status: "done", ago: 4 * D + 2 * H,
    inputs: { test: "src/checkout/coupon.test.ts", tries: 20 },
    result: "The coupon field raced the price fetch. The test now waits for the price. 20 of 20 passed.",
    tree: [
      C("run", "reproduce", "scripts/flaky.sh src/checkout/coupon.test.ts 20", { d: 1 * M + 10 * S, out: "failed 4 of 20\napplies a coupon: expected 90 to be 81" }),
      A("investigate", "investigator", { d: 5 * M + 20 * S, tok: 31800, acts: [T("Read", "src/checkout/Coupon.tsx", "88 lines"), X("The coupon field raced the price fetch. Smallest fix: wait for the price before applying.")] }),
      Retry("fix", 2, [{ ok: true, v: "check exited 0: 5 of 5 passed", steps: [
        A("fix", "implementer", { d: 2 * M + 50 * S, tok: 17400, acts: [T("Edit", "src/checkout/coupon.test.ts", "+3 -1"), X("The test now waits for the price.")] }),
        C("sh", "check", "pnpm vitest run src/checkout/coupon.test.ts --repeat 5", { d: 30 * S, out: "Tests  5 passed (5)" })] }]),
      C("sh", "verify", "pnpm vitest run src/checkout/coupon.test.ts --repeat 20", { d: 1 * M + 40 * S, out: "Tests  20 passed (20)" }),
    ] },
];

/* ------------------------------------------------------------------ build: ids, models, tokens, times */
const PRICE = { opus: [15, 75, 1.5], sonnet: [3, 15, 0.3], haiku: [1, 5, 0.1], "gpt-6.1-sol": [5, 30, 0.5], "gpt-6-luna": [1.5, 6, 0.15] };
const GAP = 400;

function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }

function promptFor(run, n, ctx) {
  const i = ctx.inputs, wf = ctx.wf;
  const by = {
    "ticket/implementer": () => "Implement this ticket:\n" + i.ticket,
    "ticket/reviewer": () => "Review the change for: " + i.ticket,
    "ticket/address review": () => "Address this review:\n" + (n.prevVerdict || ""),
    "factory/triager": () => "Sort these tickets into clear and vague:\n" + (ctx.find("fetch") || {}).out,
    "review-pr/reviewer": () => "Review this diff:\n" + (ctx.find("diff") || {}).out,
    "review-pr/security": () => "Look for security problems in:\n" + (ctx.find("diff") || {}).out,
    "review-pr/comment": () => "Write one review comment from these two reviews:\n\n(the reviewer's review)\n\n(the security review)",
    "release-notes/draft": () => "Write release notes from these merges:\n" + (ctx.find("log") || {}).out,
    "fix-flaky/investigate": () => "This test fails now and then:\n" + i.test + "\n\n" + (ctx.find("reproduce") || {}).out,
    "fix-flaky/fix": () => "Fix the cause (attempt " + (n.attemptNo || 1) + "):\n" + ((ctx.find("investigate") || {}).acts || []).filter((a) => a.k === "text").map((a) => a.t).pop(),
    "docs-sync/update docs": () => "Update the docs for these changes:\n" + (ctx.find("changes") || {}).out,
    "docs-sync/review": () => "Check the docs read well and match the code",
    "triage-bugs/triage": () => "Label the new bugs of team " + i.team,
    "triage-bugs/plan": () => "Plan a fix for each urgent bug:\n(the triage result)",
    "migrate-billing-webhooks-to-the-new-queue/migrate": () => "Move each handler to the queue. Keep 5 tries with backoff:\n" + (ctx.find("inventory") || {}).out,
  };
  const f = by[wf + "/" + n.label];
  if (f) return f();
  if (wf === "deps-update") return "Update " + n.label.replace("upgrade ", "") + " and fix what breaks";
  return "Prompt sent to the agent for " + n.label + ".";
}

function buildRun(sp) {
  const run = Object.assign({}, sp);
  run.tree = { k: "root", label: sp.wf, kids: sp.tree };
  let nid = 0;
  const flat = [];
  const find = (label) => flat.find((x) => x.label === label && !isGroup(x));
  // ids, parents, depth, harness and model, tokens
  const prep = (n, parent, ctx) => {
    n.id = "n" + (nid++);
    n.parent = parent;
    n.run = run;
    n.ctx = ctx;
    if (!n.s) n.s = null;
    flat.push(n);
    if (n.k === "agent") {
      const step = { kind: "agent", agent: n.agent, model: n.model };
      const m = savedModel(step, run.project);
      n.harness = m.harness; n.modelName = m.model; n.effort = m.effort;
      if (n.tok != null) {
        const pr = PRICE[n.modelName] || PRICE.sonnet;
        n.tokIn = Math.round(n.tok * 0.84); n.tokOut = n.tok - n.tokIn; n.tokCache = Math.round(n.tok * 2.6);
        n.cost = (n.tokIn * pr[0] + n.tokOut * pr[1] + n.tokCache * pr[2]) / 1e6;
      }
      if (n.keep || n.cont) n.session = "ses-" + hashStr(run.id + ctx.path + "implementer").slice(0, 6);
      if (!n.noPrompt && n.s !== "queued") n.acts = [P("")].concat(n.acts || []);
    }
    if (n.k === "wf") {
      const w = WF[n.wf], inputs = {};
      w.inputs.forEach((x) => { if (x.def != null) inputs[x.name] = x.def; });
      Object.assign(inputs, n.inputs || {});
      n.inputs = inputs;
      ctx = { wf: n.wf, inputs, path: ctx.path + n.label + "/", find };
    }
    if (n.k === "attempt") { n.attemptNo = parent.kids.indexOf(n) + 1; }
    (n.kids || []).forEach((c, i) => {
      if (n.k === "attempt") { c.attemptNo = n.attemptNo; if (n.attemptNo > 1) c.prevVerdict = parent.kids[n.attemptNo - 2].verdict; }
      prep(c, n, ctx);
    });
  };
  prep(run.tree, null, { wf: run.wf, inputs: run.inputs, path: "", find });
  // prompts, once every step is known
  flat.forEach((n) => { if (n.k === "agent") { n.prompt = promptFor(run, n, n.ctx); if (n.acts && n.acts[0] && n.acts[0].k === "prompt") n.acts[0].t = n.prompt; } });
  run.flat = flat;
  // status of groups, from their steps
  const status = (n) => {
    if (!isGroup(n)) return n.s || "done";
    const ks = n.kids.map(status);
    let s;
    if (n.k === "attempt" && n.ok === false && !ks.some((x) => x === "running" || x === "waiting")) s = "failed";
    else if (n.k === "bp" && n.s) s = n.s === "approved" ? "done" : n.s;
    else if (n.s) s = n.s;
    else if (!ks.length) s = "queued";
    else if (ks.includes("waiting")) s = "waiting";
    else if (ks.includes("running")) s = "running";
    else if (ks.includes("paused")) s = "paused";
    else if (ks.every((x) => x === "queued")) s = "queued";
    else if ((n.k === "gate" || n.k === "retry")) {
      const last = n.kids[n.kids.length - 1];
      s = last.ok ? "done" : n.kids.length >= n.max ? "failed" : "done";
    }
    else if (ks.includes("failed")) s = "failed";
    else if (ks.includes("stopped")) s = "stopped";
    else s = "done";
    n.status = s;
    return s;
  };
  flat.forEach((n) => { if (!isGroup(n)) n.status = n.s || "done"; });
  status(run.tree);
  // times: offsets in ms from the run's start
  const place = (n, t) => {
    if (n.status === "queued" || n.status === "skipped") { n.start = null; n.end = null; return t; }
    if (!isGroup(n)) {
      n.queuedAt = t; n.start = t + (n.q || 0);
      if (n.tries) n.d = n.tries.reduce((a, x) => a + x.d, 0) + (n.tries.length - 1) * 2000;
      n.end = n.status === "running" ? null : n.start + (n.d || 0);
      if (n.status === "waiting") { n.askedAt = n.end; n.end = null; }
      return n.end == null ? n.start + (n.d || 0) : n.end;
    }
    let ends = [], open = false;
    if (n.k === "par" || n.k === "pipe") {
      n.kids.forEach((c) => { const e = place(c, t); ends.push(e); if (c.end == null && c.start != null) open = true; });
      n.start = t;
    } else {
      let cur = t;
      n.kids.forEach((c, i) => {
        const e = place(c, cur);
        if (c.start != null) { if (n.start == null) n.start = c.start; ends.push(e); if (c.end == null) open = true; cur = e + GAP; }
      });
      if (n.start == null) n.start = n.kids.length ? null : t;
      if (n.k === "bp" && n.status === "waiting") open = true;
      if (n.k === "bp" && n.waited && n.status !== "waiting") { const e = Math.max.apply(null, ends.concat([t])) + n.waited; ends.push(e); n.waitedFrom = e - n.waited; }
    }
    const e = ends.length ? Math.max.apply(null, ends) : t;
    n.end = open ? null : (n.start == null ? null : e);
    return e;
  };
  run.tree.start = 0;
  const lastEnd = place(run.tree, 0);
  // when the run started, so that open steps have run for a sensible time
  run.span = lastEnd;
  const open = flat.filter((n) => !isGroup(n) && (n.status === "running" || n.status === "waiting"));
  const minAgo = open.length ? Math.max.apply(null, open.map((n) => n.status === "running" ? n.start + 4 * S : (n.askedAt || n.start) + 30 * S)) : lastEnd;
  run.startedAt = NOW - Math.max(sp.ago, minAgo);
  if (["done", "failed", "stopped"].includes(run.status)) run.endedAt = run.startedAt + lastEnd;
  if (run.status === "paused") run.pausedAt = run.startedAt + lastEnd;
  // questions waiting on this run
  run.asks = flat.filter((n) => n.ask && n.status === "waiting").map((n) => Object.assign({ node: n }, n.ask));
  return run;
}

const RUNS = SPECS.map(buildRun);
RUNS.forEach((r) => r.flat.forEach((n) => { if (n.acts) n.acts.forEach((a) => { if (a.t && a.t.includes("{resume}") && r.pause) a.t = a.t.replace("{resume}", fmtClock(r.pause.resumesAt)); }); }));

/* ------------------------------------------------------------------ 200 runs across 6 projects, for the "many" state */
function manyRuns() {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const projects = ["orchestrator", "site", "docs", "billing", "mobile", "infra"];
  const verbs = ["Fix", "Add", "Move", "Rename", "Test", "Split", "Cache", "Document", "Remove", "Retry"];
  const things = ["the login redirect", "invoice PDFs", "the search index", "push tokens", "the deploy script", "dark mode tokens", "webhook retries", "the settings page", "rate limits", "the onboarding email", "flaky e2e tests", "the CSV export", "the iOS build", "Terraform state", "the cron jobs"];
  const wfs = ["ticket", "ticket", "ticket", "review-pr", "fix-flaky", "docs-sync", "deps-update", "release-notes"];
  const out = [];
  for (let i = 0; i < 200; i++) {
    const wf = pick(wfs);
    const r = rnd();
    const status = i < 3 ? "question" : r < 0.04 ? "failed" : r < 0.1 ? "running" : r < 0.14 ? "paused" : r < 0.18 ? "stopped" : "done";
    const label = wf === "review-pr" ? "PR " + (300 + Math.floor(rnd() * 400)) : wf === "deps-update" ? "scope " + pick(["patch", "minor"]) : wf === "release-notes" ? "since v" + (1 + Math.floor(rnd() * 3)) + "." + Math.floor(rnd() * 9) + ".0" : wf === "docs-sync" ? "ref main" : pick(verbs) + " " + pick(things);
    const ago = Math.floor(Math.pow(rnd(), 1.6) * 30 * D) + i * 30 * S;
    const like = RUNS.find((x) => x.status === status && x.wf === wf) || RUNS.find((x) => x.status === status) || RUNS[0];
    out.push({ id: like.id, gid: "g" + i, wf, project: projects[i % 6], label, status, startedAt: NOW - ago, endedAt: ["done", "failed", "stopped"].includes(status) ? NOW - ago + (2 + Math.floor(rnd() * 40)) * M : null, gen: true, asks: status === "question" ? [{}] : [] });
  }
  return out;
}
