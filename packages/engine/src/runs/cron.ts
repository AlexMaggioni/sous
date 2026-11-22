// Five-field cron: minute hour day-of-month month day-of-week, in local time.
// Each field takes *, a number, a range a-b, a list a,b and a step */n or a-b/n.
// Sunday is 0 or 7. When both day fields are set, either one matching is enough.
// @hourly, @daily, @weekly and @monthly are short forms.

const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};

const BOUNDS: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

export interface Cron {
  fields: Array<Set<number>>;
  domStar: boolean;
  dowStar: boolean;
}

function parseField(text: string, [min, max]: [number, number], name: string): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in ${name}: "${part}"`);
    let from: number;
    let to: number;
    if (range === "*") {
      from = min;
      to = max;
    } else if (range!.includes("-")) {
      const [a, b] = range!.split("-").map(Number);
      from = a!;
      to = b!;
    } else {
      from = Number(range);
      to = stepText === undefined ? from : max;
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) {
      throw new Error(`bad ${name} in cron: "${part}" (allowed ${min}-${max})`);
    }
    for (let value = from; value <= to; value += step) out.add(value);
  }
  return out;
}

export function parseCron(expression: string): Cron {
  const text = ALIASES[expression.trim()] ?? expression.trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron needs five fields (minute hour day month weekday), got "${expression}"`);
  const names = ["minute", "hour", "day of month", "month", "day of week"];
  const fields = parts.map((part, i) => parseField(part, BOUNDS[i]!, names[i]!));
  if (fields[4]!.has(7)) fields[4]!.add(0);
  return { fields, domStar: parts[2] === "*", dowStar: parts[4] === "*" };
}

export function cronMatches(cron: Cron, date: Date): boolean {
  const [minute, hour, dom, month, dow] = cron.fields;
  if (!minute!.has(date.getMinutes()) || !hour!.has(date.getHours()) || !month!.has(date.getMonth() + 1)) return false;
  const domOk = dom!.has(date.getDate());
  const dowOk = dow!.has(date.getDay());
  if (cron.domStar && cron.dowStar) return true;
  if (cron.domStar) return dowOk;
  if (cron.dowStar) return domOk;
  return domOk || dowOk;
}

/** The next minute after `from` that matches, within a year. */
export function nextRun(cron: Cron, from: Date = new Date()): Date | undefined {
  const date = new Date(from);
  date.setSeconds(0, 0);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    date.setMinutes(date.getMinutes() + 1);
    if (cronMatches(cron, date)) return new Date(date);
  }
  return undefined;
}
