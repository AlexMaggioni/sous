// One format per unit, the same everywhere, as DESIGN.md says under Type.

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 840ms, 12s, 4m 08s, 1h 12m. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  if (ms < SEC) return `${Math.max(0, Math.round(ms))}ms`;
  const s = Math.round(ms / SEC);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${pad2(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${pad2(m % 60)}m`;
}

/** 980, 12.4k, 1.25M. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "";
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1e6).toFixed(2)}M`;
}

/** $0.42, and under half a cent "<$0.01", so a run that spent something never reads as free. */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd)) return "";
  if (usd > 0 && usd < 0.005) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** Nov 23. */
export function formatDate(at: Date | number): string {
  return new Date(at).toLocaleDateString("en", { month: "short", day: "numeric" });
}

/** The full date and time, for a tooltip: Mon, Nov 23, 2026, 14:05:09. */
export function formatFull(at: Date | number): string {
  return new Date(at).toLocaleString("en", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** just now, 3m ago, 5h ago, then the date past a day. In the future: in 4m, in 2h. */
export function formatAgo(at: Date | number, now: Date | number = Date.now()): string {
  const d = new Date(now).getTime() - new Date(at).getTime();
  if (d < -45 * SEC) {
    if (-d < HOUR) return `in ${Math.round(-d / MIN)}m`;
    if (-d < DAY) return `in ${Math.round(-d / HOUR)}h`;
    return formatDate(at);
  }
  if (d < 45 * SEC) return "just now";
  if (d < HOUR) return `${Math.round(d / MIN)}m ago`;
  if (d < DAY) return `${Math.round(d / HOUR)}h ago`;
  return formatDate(at);
}

/** A row's age, short: now, 3m, 5h, then the date. A time it can't read counts as long ago. */
export function shortAge(at: string, now: number): string {
  const t = Date.parse(at);
  const d = now - (Number.isNaN(t) ? 0 : t);
  if (d < 45 * SEC) return "now";
  if (d < HOUR) return `${Math.round(d / MIN)}m`;
  if (d < DAY) return `${Math.round(d / HOUR)}h`;
  return formatDate(Number.isNaN(t) ? 0 : t);
}

/** The time of day as a clock, 14:05:09. */
export function clock(at: Date | number | string): string {
  return new Date(at).toLocaleTimeString("en", { hour12: false });
}

/** A tick of a time axis: 0s, 30s, 1m, 1m 30s, 1h 05m. */
export function tickLabel(ms: number): string {
  const s = Math.round(ms / SEC);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${pad2(s % 60)}s` : ""}`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${pad2(m % 60)}m` : ""}`;
}

/** "1 item", "3 items", or "2 branches" with the plural given. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The lines of a text. A newline at its end closes the last line and starts no new one. */
export function lineCount(text: string): number {
  return text.replace(/\n$/, "").split("\n").length;
}
