// sous inbox, answer, approve and send-back: the questions runs ask.

import { answerCallsFor, answerQuestion, findQuestion, hint, loadRecord, questionView, runQuestions, type HomePaths, type Reply as Typed, type RunQuestion } from "@sous/engine";
import { Usage, type Parsed } from "../args.js";
import { reply, type Reply } from "../reply.js";
import { age, needRun, stopReply } from "./common.js";
import { answerNext, resumeNext, waitNext } from "./next.js";
import type { Ctx } from "./index.js";

function needQuestion(paths: HomePaths, id: string | undefined): RunQuestion {
  if (!id) throw new Usage("give a question id (sous inbox shows them)");
  return findQuestion(paths, id);
}

export function cmdInbox(args: Parsed, ctx: Ctx): Reply<object> {
  const { paths } = ctx;
  const questions = args.positional[0] ? needRun(paths, args.positional[0]).questions : runQuestions(paths);
  if (ctx.json) {
    // Each question as wait shows it, with who may answer it for its run, and the caller's answer calls.
    const views = questions.map((question) => ({ ...questionView(question, loadRecord(paths, question.runId)), runId: question.runId, workflow: question.workflow }));
    return reply({ questions: views }, { next: views.flatMap((view) => answerNext(view, ctx.who)) });
  }
  if (!questions.length) return reply({}, { text: ["nothing waits for you"] });
  const text = questions.flatMap((question) => [
    `${question.id}  ${question.workflow}  ${age(question.askedAt, ctx.now())} ago`,
    `  ${question.prompt.replace(/\n/g, "\n  ")}`,
    `  ${hint(question)}`,
  ]);
  return reply({}, { text });
}

/** Words that look like a JSON object or list. */
const looksLikeJson = (text: string): boolean => /^\s*[[{]/.test(text);

export function cmdAnswer(args: Parsed, ctx: Ctx, via: Exclude<Typed["via"], "prompt">): Reply<object> {
  const { paths } = ctx;
  const question = needQuestion(paths, args.positional[0]);
  const { id, runId } = question;
  const text = args.positional.slice(1).join(" ");
  const valueJson = args.flags["value-json"] === true;
  const answer = answerQuestion(paths, question, { via, text, valueJson }, ctx.who);
  if ("usage" in answer) {
    if (!answer.choices) throw new Usage(answer.usage);
    throw new Usage(answer.usage, "not_a_choice", "Answer with one of the choices.", answerCallsFor(paths, question, ctx.who)[0] ?? null);
  }
  if ("stopped" in answer) return stopReply(runId, answer.stopped, { question: id, runId, answered: true, outcome: answer.stopped.outcome });
  const notes: string[] = [];
  if (via === "answer" && !question.breakpoint && !valueJson && looksLikeJson(text)) notes.push("The answer went as text. Add --value-json to pass it as JSON.");
  if (answer.notJson) notes.push("The text is not JSON, so it went as text.");
  const next = answer.running
    ? [waitNext(runId, "waits for the run, which goes on with the answer")]
    : [resumeNext(runId, "resumes the run, which uses the answer")];
  return reply(
    { question: id, runId, answered: true, running: answer.running, by: ctx.who.by, through: ctx.who.through },
    { text: [`answered ${id}${answer.running ? "" : `. The run is not running: sous resume ${runId} uses the answer.`}`], notes, next },
  );
}
