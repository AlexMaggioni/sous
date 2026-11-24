// sous inbox, answer, approve and send-back: the questions runs ask.

import { answerQuestion, findQuestion, hint, runQuestions, type HomePaths, type Reply as Typed, type RunQuestion } from "@sous/engine";
import { Usage, type Parsed } from "../args.js";
import { reply, type Reply } from "../reply.js";
import { age, needRun, stopText } from "./common.js";
import type { Ctx } from "./index.js";

function needQuestion(paths: HomePaths, id: string | undefined): RunQuestion {
  if (!id) throw new Usage("give a question id (sous inbox shows them)");
  return findQuestion(paths, id);
}

export function cmdInbox(args: Parsed, ctx: Ctx): number | Reply<object> {
  const { paths, machine } = ctx;
  const questions = args.positional[0] ? needRun(paths, args.positional[0]).questions : runQuestions(paths);
  if (ctx.json) return reply({ questions });
  if (!questions.length) {
    machine.out("nothing waits for you");
    return 0;
  }
  for (const question of questions) {
    machine.out(`${question.id}  ${question.workflow}  ${age(question.askedAt, ctx.now())} ago`);
    machine.out(`  ${question.prompt.replace(/\n/g, "\n  ")}`);
    machine.out(`  ${hint(question)}`);
  }
  return 0;
}

export function cmdAnswer(args: Parsed, ctx: Ctx, via: Exclude<Typed["via"], "prompt">): number {
  const { paths, machine } = ctx;
  const question = needQuestion(paths, args.positional[0]);
  const text = args.positional.slice(1).join(" ");
  const answer = answerQuestion(paths, question, { via, text, json: ctx.json });
  if ("usage" in answer) {
    if (!answer.choices) throw new Usage(answer.usage);
    throw new Usage(answer.usage, "not_a_choice", "Answer with one of the choices.", `sous answer ${question.id} <${answer.choices.join("|")}>`);
  }
  if ("answered" in answer) machine.out(`answered ${question.id}${answer.running ? "" : `. The run is not running: sous resume ${question.runId} uses the answer.`}`);
  if ("stopped" in answer) machine.out(stopText(question.runId, answer.stopped));
  return 0;
}
