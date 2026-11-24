// The line diff of two texts, for `sous workflows show --diff`: what changed in a workflow since
// the person's last yes. It keeps every line. Cutting the context around a change is the caller's.

/** A text's lines. A final newline makes no line of its own, and an empty text has none. */
function linesOf(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * The lines of `after` against `before`, in order: "- " for a line only before, "+ " for a line
 * only after, and two spaces for a line both keep. A changed line gives its "- " line, then its
 * "+ " line. The matched lines are a longest common run of lines, so a diff is as short as it can be.
 */
export function lineDiff(before: string, after: string): string[] {
  const a = linesOf(before);
  const b = linesOf(after);
  // The lines both texts start and end with match as they are, so only the middle is compared.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const from = a.slice(start, a.length - end);
  const to = b.slice(start, b.length - end);
  return [...a.slice(0, start).map(same), ...middle(from, to), ...a.slice(a.length - end).map(same)];
}

const same = (line: string) => `  ${line}`;

/** The diff of two lists of lines, from the table of their longest common lines. */
function middle(a: string[], b: string[]): string[] {
  const width = b.length + 1;
  // common[i * width + j] is how many lines a[i..] and b[j..] have in common, in order.
  const common = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i * width + j] = a[i] === b[j] ? common[(i + 1) * width + j + 1]! + 1 : Math.max(common[(i + 1) * width + j]!, common[i * width + j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(same(a[i++]!));
      j++;
    } else if (j >= b.length || (i < a.length && common[(i + 1) * width + j]! >= common[i * width + j + 1]!)) {
      out.push(`- ${a[i++]}`);
    } else {
      out.push(`+ ${b[j++]}`);
    }
  }
  return out;
}
