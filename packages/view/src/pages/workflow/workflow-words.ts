import type { Input, WorkflowPage } from "../../api/contract.ts";

// The words of a workflow page: its schedule, where it works, who approved it, and each input.

const pad = (n: number) => String(n).padStart(2, "0");
const DAYS: Record<string, string> = { "*": "Every day", "1-5": "Weekdays", "0": "Sundays", "1": "Mondays", "2": "Tuesdays", "3": "Wednesdays", "4": "Thursdays", "5": "Fridays", "6": "Saturdays", "7": "Sundays" };

/** A simple cron in words, such as "Weekdays at 09:00". Undefined for any other cron, which shows as is. */
export function cronWords(cron: string): string | undefined {
  const m = cron.trim().match(/^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-7])$/);
  if (!m) return undefined;
  return `${DAYS[m[3]!]} at ${pad(Number(m[2]))}:${pad(Number(m[1]))}`;
}

/** Where a run of it works, as the meta's place says. */
export function placeWords(place: string | undefined): { value: string; sub?: string } {
  switch (place) {
    case "worktree":
      return { value: "A worktree", sub: "A new branch for each run" };
    case "folder":
      return { value: "The project folder" };
    case "none":
      return { value: "No folder" };
    case undefined:
      return { value: "The default place", sub: "The meta names none, so config.json decides" };
    default:
      return { value: place };
  }
}

const BY = { person: "by you", agent: "by an agent, with your yes", sous: "by sous" } as const;

/** Who gave the last yes to its text. */
export function approvedBy(approved: NonNullable<WorkflowPage["approved"]>): string {
  return approved.seeded ? "by sous, on its first use here" : BY[approved.by];
}

/** What an input takes, such as "number, required" or "string, default "main"". */
export function inputWords(input: Input): string {
  const parts: string[] = [input.type];
  if (input.required) parts.push("required");
  if (input.default !== undefined) parts.push(`default ${JSON.stringify(input.default)}`);
  if (!input.required && input.default === undefined) parts.push("optional");
  if (input.choices?.length) parts.push(`one of ${input.choices.join(", ")}`);
  return parts.join(", ");
}
