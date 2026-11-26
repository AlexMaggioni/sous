// The Search row's filter. Every word the person types must appear in one of the row's texts,
// in any order and any case, so "shop fix" finds a fix-tests run in the shop project.

/** Whether every word of `query` appears in one of `texts`. An empty query matches every row. */
export function matches(texts: readonly (string | undefined)[], query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = texts.filter(Boolean).join("\n").toLowerCase();
  return words.every((word) => hay.includes(word));
}
