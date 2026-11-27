// The leading slash command of a Codex prompt. The app-server reads no slash command from text,
// so the adapter maps each one it knows to the app-server's own method or input.

/** What a prompt asks of Codex. */
export type Slash =
  /** A prompt with no command, which goes as text. */
  | { kind: "text" }
  /** `/goal <objective>`, which thread/goal/set runs. */
  | { kind: "goal"; objective: string }
  /** `/goal` alone, which reports the thread's goal. */
  | { kind: "goal-show" }
  /** `/goal clear`, which clears it. */
  | { kind: "goal-clear" }
  /** `/review`, of the changes not committed, or with its own instructions. */
  | { kind: "review"; instructions?: string }
  /** `/compact`, which compacts the thread's context. */
  | { kind: "compact" }
  /** `/prompts:<name>`, a prompt file in the Codex home's prompts folder. */
  | { kind: "prompt"; name: string; args: string }
  /** Any other command: a skill when skills/list names it, else a command Codex does not have. */
  | { kind: "command"; name: string; rest: string };

// A command is a slash, a name, then a space or the end, so a path such as /tmp/x is text.
const COMMAND = /^\/([A-Za-z][\w.-]*(?::[\w.-]+)?)(?:\s+([\s\S]*))?$/;

/** The command a prompt starts with. */
export function readSlash(prompt: string): Slash {
  const match = COMMAND.exec(prompt);
  if (!match) return { kind: "text" };
  const name = match[1]!;
  const rest = (match[2] ?? "").trim();
  if (name === "goal") return rest === "" ? { kind: "goal-show" } : rest === "clear" ? { kind: "goal-clear" } : { kind: "goal", objective: rest };
  if (name === "review") return rest === "" ? { kind: "review" } : { kind: "review", instructions: rest };
  if (name === "compact") return { kind: "compact" };
  if (name.startsWith("prompts:")) return { kind: "prompt", name: name.slice("prompts:".length), args: rest };
  return { kind: "command", name, rest };
}

/**
 * A prompt file's text for its arguments, as the full-screen view expands it. The front matter
 * goes. $ARGUMENTS is every argument, $1 to $9 each one by position, KEY=value arguments fill
 * $KEY, and $$ is a dollar sign.
 */
export function expandPrompt(file: string, args: string): string {
  const body = file.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const words = args.match(/"[^"]*"|\S+/g)?.map((word) => word.replace(/^"(.*)"$/, "$1")) ?? [];
  const named = new Map(words.flatMap((word) => (/^[A-Z][A-Z0-9_]*=/.test(word) ? [[word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1)] as const] : [])));
  return body.replace(/\$(\$|ARGUMENTS\b|[1-9]|[A-Z][A-Z0-9_]*)/g, (whole, key: string) => {
    if (key === "$") return "$";
    if (key === "ARGUMENTS") return args;
    if (/^[1-9]$/.test(key)) return words[Number(key) - 1] ?? "";
    return named.get(key) ?? whole;
  });
}

/** The text of /goal alone: the goal and its status, or that the thread has none. */
export function goalReport(goal: { objective: string; status: string } | null): string {
  return goal ? `Goal (${goal.status}): ${goal.objective}` : "No goal set";
}
