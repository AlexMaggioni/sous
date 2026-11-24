// The command line of one sous command: its words, its flags and the workflow's inputs.

/** A wrong command line. sous prints it after "usage:" and exits with 64. */
export class Usage extends Error {}

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
  ...["place", "model", "project", "concurrency", "priority", "cron", "days", "lines", "step", "answers", "by", "budget", "timeout", "note"].map((name) => ({ name, takes: "one" as const })),
  { name: "set", takes: "many", value: "label.key=value" },
  ...["wait", "json", "all", "follow", "f", "dry-run", "yes", "reuse", "latest", "same", "live", "help", "h", "let-agent-answer"].map((name) => ({ name, takes: "none" as const })),
];

export const RESERVED: readonly string[] = OWN.map((flag) => flag.name);

/** The specs of the flags with these names. A name sous does not own has none. */
export function flagsNamed(names: string[]): FlagSpec[] {
  return OWN.filter((flag) => names.includes(flag.name));
}

/**
 * Read one command's argv, the command name left out. The command's own flags go to `flags`. With
 * `takesInputs`, any other --name value is a workflow input, and so is everything after `--`. A
 * flag sous owns that this command does not take is refused there, so it never becomes an input.
 * Without `takesInputs`, other flags are read and dropped.
 */
export function parseArgs(argv: string[], flags: FlagSpec[], takesInputs: boolean): Parsed {
  const parsed: Parsed = { positional: [], flags: {}, inputs: {} };
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
      if (sous && takesInputs) {
        throw new Usage(`this command does not take --${name}. To give the workflow an input named ${name}, put it after --, as in -- --${name} value`);
      }
      const spec = mine ?? sous;
      if (!spec) {
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
  return parsed;
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
