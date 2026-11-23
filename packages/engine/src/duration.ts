// A duration as a script or a run record writes it: a timeout, a polling interval.

/** Parse "90", 90, "90s", "10m", "2h" into seconds. Returns undefined for anything else. */
export function parseDurationSeconds(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  const seconds = unit === "ms" ? amount / 1000 : unit === "m" ? amount * 60 : unit === "h" ? amount * 3600 : amount;
  return seconds > 0 ? seconds : undefined;
}
