// Who calls sous, from the shell markers of the environment main is given. A step of a run has
// SOUS_RUN_ID, and also the markers of the program it runs in, so it comes first. A Codex session
// started from a Claude Code shell has both programs' markers, so Codex comes before Claude Code.
// No marker means the person at their own terminal.

import { Refusal, type Through, type Who } from "@sous-run/engine";
import { Usage } from "./args.js";

const MARKERS: Array<(env: NodeJS.ProcessEnv) => Through | undefined> = [
  (env) => (env.SOUS_RUN_ID ? { kind: "run", runId: env.SOUS_RUN_ID } : undefined),
  (env) => (env.CODEX_THREAD_ID ? { kind: "agent", program: "codex", session: env.CODEX_THREAD_ID } : undefined),
  (env) => (env.CLAUDECODE === "1" ? { kind: "agent", program: "claude", ...(env.CLAUDE_CODE_SESSION_ID ? { session: env.CLAUDE_CODE_SESSION_ID } : {}) } : undefined),
];

/**
 * Who calls, and through what. `by` follows `through`: the person decides at their terminal, and
 * an agent or a step of a run decides there. `by` "person", from --by person, is the agent's word
 * that the person decided: it keeps `through`. It takes no other value, and a step of a run has no
 * person to speak for.
 */
export function whoIsCalling(env: NodeJS.ProcessEnv, by?: string): Who {
  const through = MARKERS.map((marker) => marker(env)).find(Boolean) ?? { kind: "person" as const };
  if (by !== undefined && by !== "person") throw new Usage(`--by takes only person, got "${by}"`, "bad_argument", "Give --by person when the person decided, or leave --by out.");
  if (by === "person" && through.kind === "run") {
    const message = `a step of run ${through.runId} has no person to speak for, so it cannot give --by person.`;
    throw new Refusal("no_person_here", message, "Leave --by person out. A step answers only a question open to anyone. The person answers the rest, and the run waits for them.", null);
  }
  return { by: by === "person" || through.kind === "person" ? "person" : "agent", through };
}

/** A word as a shell reads it: as it is when it is plain, else in single quotes. */
const quoted = (word: string) => (/^[\w./~=:@%+,-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`);

/**
 * The command a person types for this call: sous and its words, without --json and --by, which
 * are for the agent. Words after "--" stay as they are.
 */
export function personCommand(argv: string[]): string {
  const split = argv.indexOf("--");
  const head = split === -1 ? argv : argv.slice(0, split);
  const words: string[] = [];
  for (let i = 0; i < head.length; i++) {
    const word = head[i]!;
    if (word === "--json" || word.startsWith("--by=")) continue;
    if (word === "--by") {
      i++;
      continue;
    }
    words.push(word);
  }
  return ["sous", ...words, ...(split === -1 ? [] : argv.slice(split))].map(quoted).join(" ");
}
