// The program's own question tool, on a step with ask. Both programs send a list of questions,
// each with a text and maybe options. sous refuses the call, keeps the questions and ends the turn.

/** What the program reads back when sous refuses its question tool on a step with ask. */
export const ASKED_REFUSAL = "The person will step into this session to answer you. End your turn now.";

/**
 * The questions as plain text: each question on a line, and after a question with options a line
 * "Options: A, B". Input that holds no question text comes back as its JSON.
 */
export function questionText(input: unknown): string {
  const questions = (input as { questions?: unknown } | null)?.questions;
  const lines: string[] = [];
  for (const entry of Array.isArray(questions) ? questions : []) {
    const question = (entry as { question?: unknown } | null)?.question;
    if (typeof question !== "string" || !question.trim()) continue;
    lines.push(question.trim());
    const options = (entry as { options?: unknown }).options;
    const labels = (Array.isArray(options) ? options : []).map((option) => (option as { label?: unknown } | null)?.label).filter((label): label is string => typeof label === "string" && label !== "");
    if (labels.length) lines.push(`Options: ${labels.join(", ")}`);
  }
  return lines.length ? lines.join("\n") : JSON.stringify(input ?? null);
}

/** Adds a question to the turn's earlier ones. */
export function addAsked(earlier: string | undefined, question: string): string {
  return earlier ? `${earlier}\n${question}` : question;
}
