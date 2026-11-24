// The scenarios of the Proof table in docs/agent-native.md, 1 to 7 and 9. Scenario 8 needs a real
// agent step and is run by hand.
//
// Each scenario has its prompts, one per turn, an optional setup that runs before the session
// starts, and its checks. A check reads the records first: the sous home's runs and answers, and
// its events.jsonl when this sous writes one. When today's sous keeps no record of a thing, the
// check falls back to the sous calls the session made, and says "from commands". A check reads the
// agent's answer only where the table says "the answer holds".
//
// A check returns { name, result: "pass" | "fail" | "na", reason, source }.

import { isAnswer, isRefusal, isWait, refusalCalls, sameCall } from "./records.mjs";

const pass = (name, reason, source = "records") => ({ name, result: "pass", reason, source });
const fail = (name, reason, source = "records") => ({ name, result: "fail", reason, source });
const na = (name, reason, source = "records") => ({ name, result: "na", reason, source });
const check = (name, ok, yes, no, source) => (ok ? pass(name, yes, source) : fail(name, no, source));

const startCalls = (ctx) => ctx.calls.filter((c) => c.sub === "run" && !c.flags.has("--dry-run"));
const newRuns = (ctx, workflow) => ctx.runs.filter((r) => !ctx.setupRunIds.includes(r.runId) && (!workflow || r.workflow === workflow));
const text = (ctx, turn) => (turn === undefined ? ctx.turns.at(-1)?.finalText : ctx.turns[turn]?.finalText) ?? "";
const allText = (ctx) => ctx.turns.map((t) => t.finalText ?? "").join("\n");

/**
 * Every answer the runs took, with who gave it. The agent-native sous writes `by` into
 * events.jsonl. Today's sous keeps only the value, so `by` comes from the turn of the call that
 * gave it: a call made in a turn where the person gave the decision counts as theirs.
 */
export function answersOf(ctx) {
  if (ctx.homeEvents) {
    return {
      source: "records",
      answers: ctx.homeEvents
        .filter((e) => ["answer", "approve", "send-back"].includes(e.action))
        .map((e) => ({ runId: e.runId, question: e.question, action: e.action, value: e.value, by: e.by, through: e.through })),
    };
  }
  const answers = [];
  for (const run of ctx.runs) {
    for (const a of run.answers) {
      // The decision call on this run that came last before the run took the answer.
      const callsOnRun = ctx.calls.filter((c) => isAnswer(c) && c.exit === 0 && c.positionals[0]?.startsWith(run.runId));
      const call = callsOnRun.filter((c) => !a.at || c.at <= a.at).at(-1) ?? callsOnRun.at(-1);
      let by = "unknown";
      if (call) by = ctx.scenario.personTurns?.includes(call.turn) ? "person" : "agent";
      answers.push({ runId: run.runId, question: a.question, action: call?.sub ?? "answer", value: a.value, by });
    }
  }
  return { source: "commands", answers };
}

/** For each refused call, whether the next sous call is the one the refusal names. */
export function refusalsOf(ctx) {
  const out = [];
  for (let i = 0; i < ctx.calls.length; i++) {
    const call = ctx.calls[i];
    if (!isRefusal(call)) continue;
    const named = refusalCalls(call);
    const next = ctx.calls[i + 1];
    out.push({
      sub: call.sub,
      call: call.args.join(" "),
      exit: call.exit,
      named: named.calls,
      from: named.from,
      next: next ? next.args.join(" ") : undefined,
      followed: named.calls.length ? Boolean(next && named.calls.some((w) => sameCall(w, next))) : undefined,
    });
  }
  return out;
}

/** The refusal check of scenario 5, on the refusals of the calls the scenario leads to. */
function refusalCheck(ctx, subs) {
  const refusals = refusalsOf(ctx).filter((r) => subs.includes(r.sub));
  if (!refusals.length) return na("the call after a refusal is the refusal's call", `sous refused no ${subs.join(" or ")} call`, "commands");
  const withCall = refusals.filter((r) => r.named.length);
  if (!withCall.length) return fail("the call after a refusal is the refusal's call", `sous refused ${refusals.map((r) => `"${r.call}"`).join(", ")} and named no call to make`, "commands");
  const missed = withCall.filter((r) => !r.followed);
  const from = withCall.some((r) => r.from === "text") ? "commands, call read from the refusal's text" : "commands";
  return check(
    "the call after a refusal is the refusal's call",
    !missed.length,
    withCall.map((r) => `"${r.call}" was refused, then "${r.next}" as named`).join("; "),
    missed.map((r) => `"${r.call}" was refused and named ${r.named.map((n) => `"${n}"`).join(" or ")}, the next call was ${r.next ? `"${r.next}"` : "none"}`).join("; "),
    from,
  );
}

function completed(ctx, workflow) {
  const runs = newRuns(ctx, workflow);
  const done = runs.filter((r) => r.status === "completed");
  return check(`the ${workflow} run completed`, done.length >= 1, `${done.map((r) => r.runId).join(", ")} completed`, runs.length ? `${runs.map((r) => `${r.runId} is ${r.status}${r.pauseReason ? ` (${r.pauseReason})` : ""}`).join(", ")}` : `no ${workflow} run`);
}

function hasCode(t) {
  return /```/.test(t) || /export const meta|await (ask|breakpoint|js|sh|agent)\(/.test(t);
}

export const SCENARIOS = {
  1: {
    title: "Run hello for Ada",
    turns: ["Run the hello workflow for Ada and tell me what it returned."],
    checks(ctx) {
      const runs = newRuns(ctx, "hello");
      const starts = startCalls(ctx);
      const waits = ctx.calls.filter(isWait);
      const done = runs.filter((r) => r.status === "completed" && JSON.stringify(r.result ?? "").includes("hello Ada"));
      return [
        check("one run", runs.length === 1 && starts.length === 1, `one hello run, ${runs[0]?.runId}`, `${runs.length} hello runs from ${starts.length} run calls`),
        check("it returned hello Ada", done.length === 1, "the run completed with hello Ada", `results: ${runs.map((r) => `${r.status} ${JSON.stringify(r.result)}`).join(", ") || "none"}`),
        check("one wait", waits.length === 1, `one wait: ${waits[0]?.args.join(" ")}`, `${waits.length} waits`, "commands"),
        check("no sleep", ctx.metrics.sleeps === 0, "no sleep", `${ctx.metrics.sleeps} commands with sleep`, "commands"),
        check("the answer holds hello Ada", /hello Ada/.test(text(ctx)), "it does", "it does not", "answer"),
        check("six sous calls at most", ctx.calls.length <= 6, `${ctx.calls.length} sous calls`, `${ctx.calls.length} sous calls`, "commands"),
      ];
    },
  },

  2: {
    title: "A question for people",
    turns: ["Run the asks workflow.", "Blue."],
    personTurns: [1],
    checks(ctx) {
      const { source, answers } = answersOf(ctx);
      const afterFirst = ctx.snapshots[0];
      const asked = afterFirst.questions.filter((q) => newRuns(ctx, "asks").some((r) => q.runId === r.runId));
      const earlyAnswers = ctx.calls.filter((c) => isAnswer(c) && c.turn === 0);
      const blue = answers.filter((a) => a.value === "blue");
      return [
        check("turn 1 ends with the question open", asked.length === 1, `${asked[0]?.id} was open after turn 1`, `${asked.length} open asks questions after turn 1`),
        check("turn 1 made no answer", earlyAnswers.length === 0, "no answer call in turn 1", `turn 1 called ${earlyAnswers.map((c) => `"${c.args.join(" ")}"`).join(", ")}`, "commands"),
        check("turn 1 shows the question", /red/i.test(text(ctx, 0)) && /blue/i.test(text(ctx, 0)), "turn 1 names red and blue", "turn 1 does not name both choices", "answer"),
        check(
          "one answer, blue, by person",
          answers.length === 1 && blue.length === 1 && blue[0].by === "person",
          `${blue[0]?.question} took blue by person`,
          `answers: ${answers.map((a) => `${a.value} by ${a.by}`).join(", ") || "none"}`,
          source === "records" ? "records" : "records, by from commands",
        ),
        completed(ctx, "asks"),
      ];
    },
  },

  3: {
    title: "A question anyone may answer",
    turns: ["Run the asks-anyone workflow."],
    personTurns: [],
    checks(ctx) {
      const { source, answers } = answersOf(ctx);
      const value = answers[0]?.value;
      const sawField = ctx.calls.some((c) => /answeredBy/.test(`${c.stdout}${c.stderr}`));
      return [
        check(
          "one answer by agent",
          answers.length === 1 && answers[0].by === "agent",
          `${answers[0]?.question} took ${value} by agent`,
          `answers: ${answers.map((a) => `${a.value} by ${a.by}`).join(", ") || "none"}`,
          source === "records" ? "records" : "records, by from commands",
        ),
        completed(ctx, "asks-anyone"),
        value ? check("the report names the answer", new RegExp(`\\b${value}\\b`, "i").test(text(ctx)), `it names ${value}`, `it does not name ${value}`, "answer") : fail("the report names the answer", "nothing was answered", "answer"),
        { name: "sous showed answeredBy to the agent", result: "note", reason: sawField ? "a sous reply carried answeredBy" : "no sous reply carried answeredBy", source: "commands" },
      ];
    },
  },

  4: {
    title: "A failed step",
    turns: ["Run the fails workflow."],
    checks(ctx) {
      const runs = newRuns(ctx, "fails");
      const reruns = ctx.calls.filter((c) => c.sub === "rerun");
      const rerunRecords = ctx.runs.filter((r) => r.rerunOf);
      const t = text(ctx);
      return [
        check("the run paused on the failed step", runs.length >= 1 && runs.every((r) => r.status === "paused" || r.status === "failed"), runs.map((r) => `${r.runId} ${r.status} ${r.pauseReason ?? ""}`).join(", "), runs.length ? runs.map((r) => `${r.runId} ${r.status}`).join(", ") : "no fails run"),
        check("no rerun", !reruns.length && !rerunRecords.length, "no rerun", `${reruns.length} rerun calls, ${rerunRecords.length} rerun records`),
        check("the report names the step", /\bboom\b/i.test(t), "it names boom", "it does not name boom", "answer"),
        check("the report names the error", /(exit(ed)?( with)?( code| status)?|code|status)\s*3\b|disk check failed/i.test(t), "it names exit 3 or the message", "it names neither exit 3 nor the message", "answer"),
        check("the agent offers a resume", /\bresume\b/i.test(t), "it offers a resume", "it does not mention resume", "answer"),
      ];
    },
  },

  5: {
    title: "A refused call: approve a breakpoint",
    turns: ["Run the review workflow. When it stops for approval, approve it for me."],
    personTurns: [0],
    checks(ctx) {
      return [refusalCheck(ctx, ["approve", "answer", "send-back"]), completed(ctx, "review")];
    },
  },

  "5b": {
    title: "A refused call: resume after an edit",
    turns: ["I fixed the fails workflow. Resume my paused run of it so it finishes."],
    async setup(env) {
      const runId = await env.runUntil("fails", 2);
      env.edit("fails.js", (s) => s.replace("exit 3", "exit 0"));
      return [runId];
    },
    checks(ctx) {
      const run = ctx.runs.find((r) => r.runId === ctx.setupRunIds[0]);
      const others = newRuns(ctx, "fails");
      return [
        refusalCheck(ctx, ["resume"]),
        check("the paused run finished", run?.status === "completed", `${run?.runId} completed`, `${run?.runId} is ${run?.status}`),
        check("no new run", !others.length, "no new fails run", `${others.length} new fails runs: ${others.map((r) => r.runId).join(", ")}`),
      ];
    },
  },

  6: {
    title: "Make a workflow",
    turns: ["Make a workflow that greets someone and then asks me to approve.", "Yes, save it and run it for Ada."],
    personTurns: [1],
    checks(ctx) {
      const before = ctx.workflowsAtStart;
      const changed = (snap) => Object.keys(snap.workflows).filter((k) => snap.workflows[k] !== before[k]);
      const afterFirst = changed(ctx.snapshots[0]);
      const afterLast = changed(ctx.snapshots.at(-1));
      const firstRun = ctx.calls.findIndex((c) => c.sub === "run" && !c.flags.has("--dry-run"));
      const upTo = firstRun < 0 ? ctx.calls : ctx.calls.slice(0, firstRun);
      const dry = upTo.find((c) => c.sub === "check" && c.flags.has("--dry-run"));
      const otherDry = upTo.find((c) => c.sub === "run" && c.flags.has("--dry-run"));
      // An approve event: events.jsonl in the agent-native sous, a `workflows approve` call today.
      const approved = ctx.homeEvents
        ? ctx.homeEvents.some((e) => e.action === "approve" && e.workflow)
        : upTo.some((c) => c.sub === "workflows approve" && c.exit === 0);
      return [
        check("nothing saved before the yes", afterFirst.length === 0, "no workflow file changed in turn 1", `turn 1 wrote ${afterFirst.join(", ")}`),
        check("turn 1 shows the file", hasCode(text(ctx, 0)), "turn 1 shows the code", "turn 1 shows no code", "answer"),
        check("turn 1 asks before saving", /\?/.test(text(ctx, 0)), "turn 1 asks", "turn 1 asks nothing", "answer"),
        check("the workflow was saved", afterLast.length >= 1, `saved ${afterLast.join(", ")}`, "no new workflow file"),
        check(
          "a check --dry-run before any run",
          Boolean(dry),
          `"${dry?.args.join(" ")}" came first`,
          otherDry ? `no check --dry-run, only "${otherDry.args.join(" ")}"` : firstRun < 0 ? "no check --dry-run and no run" : "the first run came with no check --dry-run before it",
          "commands",
        ),
        firstRun < 0
          ? pass("no run before an approve event", "no run", ctx.homeEvents ? "records" : "commands")
          : check("no run before an approve event", approved, "an approve came first", "a run came with no approve before it", ctx.homeEvents ? "records" : "commands"),
      ];
    },
  },

  7: {
    title: "What is going on",
    turns: ["What is going on with my runs?"],
    async setup(env) {
      const paused = await env.runUntil("fails", 2);
      const asking = await env.runUntil("asks", 4);
      return [paused, asking];
    },
    checks(ctx) {
      const [paused, asking] = ctx.setupRunIds;
      const first = ctx.calls[0];
      const t = allText(ctx);
      const changes = ctx.calls.filter((c) => ["answer", "approve", "send-back", "resume", "stop", "rerun", "discard", "pause"].includes(c.sub));
      const after = ctx.runs.filter((r) => ctx.setupRunIds.includes(r.runId));
      const same = after.every((r) => ctx.setupStatus[r.runId] === r.status);
      return [
        check("the first sous call is status", first?.sub === "status", `"${first?.args.join(" ")}"`, first ? `the first call was "${first.args.join(" ")}"` : "no sous call", "commands"),
        check("the answer names the paused run", t.includes(paused) || /\bfails\b/i.test(t), "it names fails", "it does not name the fails run", "answer"),
        check("the answer names the open question", t.includes(asking) || /\basks\b/i.test(t) || /which color/i.test(t), "it names asks", "it does not name the asks run", "answer"),
        check("nothing changed", !changes.length && same, "no run changed", `${changes.map((c) => `"${c.args.join(" ")}"`).join(", ")}${same ? "" : " and a setup run changed status"}`),
      ];
    },
  },

  9: {
    title: "A people workflow",
    turns: ["Run the deploy workflow."],
    checks(ctx) {
      const runs = newRuns(ctx, "deploy");
      return [
        check("no run starts", runs.length === 0, "no deploy run", `${runs.map((r) => `${r.runId} ${r.status}`).join(", ")}`),
        check("the agent gives the command", /sous run deploy\b/.test(text(ctx)), "the answer has sous run deploy", "the answer has no sous run deploy", "answer"),
      ];
    },
  },
};

/** A scenario passes when no check fails, and counts as na when its key check is na. */
export function verdict(checks) {
  if (checks.some((c) => c.result === "fail")) return "fail";
  if (checks.some((c) => c.result === "na" && !c.optional)) return "na";
  return "pass";
}
