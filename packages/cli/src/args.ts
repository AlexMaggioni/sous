// The command line of one sous command: its words, its flags and the workflow's inputs.

/** A wrong command line. sous prints it after "usage:" and exits with 64. `not_a_choice` is an
 *  answer that is not one of the question's choices. A usage error with a change prints it, and
 *  its call, under the message. */
export class Usage extends Error {
  constructor(
    message: string,
    readonly code: "bad_argument" | "not_a_choice" = "bad_argument",
    readonly change?: string,
    readonly call: string | null = null,
  ) {
    super(message);
  }
}

export interface FlagSpec {
  name: string;
  takes: "none" | "one" | "many";
  /** What a flag that takes a value needs, for the error when it has none. */
  value?: string;
}

export interface Parsed {
  positional: string[];
  /** A switch is true. A "many" flag is the list of its values. */
  flags: Record<string, string | string[] | true>;
  /** A --name with no value is true. */
  inputs: Record<string, string | true>;
}

/** Every flag a sous command owns, today's and the ones planned. None of them is a workflow input. */
const OWN: FlagSpec[] = [
  ...["place", "model", "project", "concurrency", "priority", "cron", "days", "lines", "step", "answers", "by", "budget", "timeout", "note", "since", "after", "tail", "call"].map((name) => ({ name, takes: "one" as const })),
  { name: "set", takes: "many", value: "label.key=value" },
  ...["wait", "json", "all", "follow", "f", "dry-run", "yes", "reuse", "latest", "same", "live", "help", "h", "let-agent-answer", "value-json", "full", "line"].map((name) => ({ name, takes: "none" as const })),
];

export const RESERVED: readonly string[] = OWN.map((flag) => flag.name);

/** The specs of the flags with these names, in their order. A name sous does not own has none. */
export function flagsNamed(names: string[]): FlagSpec[] {
  return names.flatMap((name) => OWN.filter((flag) => flag.name === name));
}

/**
 * Read one command's argv, the command name left out. The command's own flags go to `flags`. With
 * `takesInputs`, any other --name value is a workflow input, and so is everything after `--`. A
 * flag sous owns that this command does not take is refused there, so it never becomes an input,
 * unless --help asks for the help. Without `takesInputs`, other flags are read and dropped.
 */
export function parseArgs(argv: string[], flags: FlagSpec[], takesInputs: boolean, command?: string): Parsed {
  const parsed: Parsed = { positional: [], flags: {}, inputs: {} };
  let refused: { name: string; value: string | true } | undefined;
  const split = argv.indexOf("--");
  const head = split === -1 ? argv : argv.slice(0, split);
  const tail = split === -1 ? [] : argv.slice(split + 1);
  const read = (list: string[], own: boolean) => {
    for (let i = 0; i < list.length; i++) {
      const arg = list[i]!;
      if (arg === "-f" && own) {
        parsed.flags.follow = true;
        continue;
      }
      if (!arg.startsWith("--")) {
        if (own) parsed.positional.push(arg);
        else throw new Usage(`after --, give inputs as --name value, got "${arg}"`);
        continue;
      }
      const eq = arg.indexOf("=");
      const name = eq > 2 ? arg.slice(2, eq) : arg.slice(2);
      const inline = eq > 2 ? arg.slice(eq + 1) : undefined;
      const takeValue = () => {
        if (inline !== undefined) return inline;
        const next = list[i + 1];
        if (next === undefined || next.startsWith("--")) return true;
        i++;
        return next;
      };
      const mine = own ? flags.find((flag) => flag.name === name) : undefined;
      const sous = own && !mine ? OWN.find((flag) => flag.name === name) : undefined;
      const spec = mine ?? sous;
      if (sous && takesInputs) {
        refused ??= { name, value: sous.takes === "none" ? true : takeValue() };
      } else if (!spec) {
        const value = takeValue();
        if (takesInputs) parsed.inputs[name] = value;
      } else if (spec.takes === "none") {
        parsed.flags[name] = true;
      } else {
        const value = takeValue();
        if (value === true) throw new Usage(`--${name} needs ${spec.value ?? "a value"}`);
        const before = parsed.flags[name];
        parsed.flags[name] = spec.takes === "many" ? [...(Array.isArray(before) ? before : []), value] : value;
      }
    }
  };
  read(head, true);
  read(tail, false);
  if (refused && !parsed.flags.help && !parsed.flags.h) throw notTaken(command, flags, parsed.positional, refused);
  return parsed;
}

/** The refusal of a sous flag the command does not take, with the call that gives it as an input. */
function notTaken(command: string | undefined, flags: FlagSpec[], positional: string[], refused: { name: string; value: string | true }): Usage {
  const who = command ? `sous ${command}` : "this command";
  const names = flags.map((flag) => `--${flag.name}`).filter((name) => name !== "--help" && name !== "--h");
  const takes = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "no flag");
  const call = [who === "this command" ? "" : who, ...positional, "--", `--${refused.name}`, refused.value === true ? "" : refused.value].filter(Boolean).join(" ");
  return new Usage(`${who} does not take --${refused.name}. It takes ${takes}. For a workflow input named ${refused.name}: ${call}`);
}

/** The value of a flag that takes one. */
export function str(value: string | string[] | true | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** --set reviewer.model=haiku gives { reviewer: { model: "haiku" } }. The label may hold dots; the key is after the last one. */
export function parseSets(sets: string[]): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const set of sets) {
    const eq = set.indexOf("=");
    const path = eq === -1 ? "" : set.slice(0, eq);
    const dot = path.lastIndexOf(".");
    if (eq === -1 || dot <= 0) throw new Usage(`--set needs label.key=value, got "${set}"`);
    const label = path.slice(0, dot);
    (out[label] ??= {})[path.slice(dot + 1)] = parseValue(set.slice(eq + 1));
  }
  return out;
}
