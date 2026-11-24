// Whether a sous call, as a guide topic or a reply writes it, parses against the commands sous has.
// COMMANDS is read when the check runs, so a command a later piece adds counts at once.

import { parseArgs, RESERVED } from "../../src/args.js";
import { COMMANDS } from "../../src/commands/index.js";

/** The words of one shell line, quotes removed. The words end at a pipe, a list operator, a
 *  redirection or a comment, so `sous status --line 2>/dev/null || true` gives three words. */
export function words(line: string): string[] {
  const out: string[] = [];
  let word = "";
  let started = false;
  let quote: '"' | "'" | undefined;
  const end = () => {
    if (started) out.push(word);
    word = "";
    started = false;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (c === " " || c === "\t") {
      end();
      continue;
    }
    // A shell operator or a comment ends the call.
    if (!started && (c === "|" || c === "&" || c === ";" || c === "#" || c === ">" || (/\d/.test(c) && line[i + 1] === ">"))) break;
    word += c;
    started = true;
  }
  end();
  return out;
}

/** What is wrong with a sous call, or undefined when it parses against COMMANDS and names only
 *  flags its command takes. A command that takes inputs may also name inputs. */
export function callProblem(call: string): string | undefined {
  const all = words(call.trim().replace(/^\$\s+/, ""));
  if (all[0] !== "sous") return `"${call}" does not start with sous`;
  const [, command, ...rest] = all;
  if (command === "help") return undefined;
  const spec = command !== undefined && Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (!spec) return `"${call}": sous ${command ?? ""} is not a command in COMMANDS`;
  try {
    parseArgs(rest, spec.flags, spec.inputs === true, command);
  } catch (error) {
    return `"${call}" does not parse: ${(error as Error).message}`;
  }
  // parseArgs drops a flag a command without inputs does not know, so check each flag here.
  const split = rest.indexOf("--");
  for (const word of split === -1 ? rest : rest.slice(0, split)) {
    if (!word.startsWith("--")) continue;
    const name = word.slice(2).split("=")[0]!;
    if (spec.flags.some((flag) => flag.name === name)) continue;
    if (spec.inputs && !RESERVED.includes(name)) continue;
    return `"${call}": sous ${command} does not take --${name}`;
  }
  return undefined;
}
