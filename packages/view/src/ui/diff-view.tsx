// What changed in a workflow file since the person approved it: added lines on a gray tint, removed ones on red.
import { useState } from "react";
import type { WorkflowDiff } from "../api/contract.ts";
import { CodeFrame, TokenLine } from "./code-block.tsx";
import { fileName } from "./facts.tsx";
import { langOf, useTokens } from "./highlight.ts";
import { ScrollBox } from "./scroll-area.tsx";

/** Unchanged lines kept around each change. Longer runs of them fold into a row that opens. */
const CONTEXT = 3;

type Row = { op: " " | "+" | "-"; text: string; no?: number };
type Piece = { kind: "row"; at: number } | { kind: "gap"; from: number; to: number };

/** Line numbers of the new text, and which unchanged lines fold away. */
function piecesOf(rows: Row[], opened: ReadonlySet<number>): Piece[] {
  const near = rows.map(() => false);
  rows.forEach((row, i) => {
    if (row.op === " ") return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(rows.length - 1, i + CONTEXT); k++) near[k] = true;
  });
  const pieces: Piece[] = [];
  let i = 0;
  while (i < rows.length) {
    if (near[i]) {
      pieces.push({ kind: "row", at: i++ });
      continue;
    }
    const from = i;
    while (i < rows.length && !near[i]) i++;
    if (opened.has(from) || i - from <= 1) for (let k = from; k < i; k++) pieces.push({ kind: "row", at: k });
    else pieces.push({ kind: "gap", from, to: i });
  }
  return pieces;
}

const SIGN = { " ": " ", "+": "+", "-": "−" } as const;
const SAID = { " ": "", "+": "Added: ", "-": "Removed: " } as const;
const TINT = { " ": "", "+": "bg-done-tint", "-": "bg-fail-tint" } as const;

/**
 * The diff `sous serve` gives for a workflow file. `path` names the file and picks its syntax
 * colors. A new file shows every line as added. A long diff says where it was cut.
 */
export function DiffView({ diff, path }: { diff: WorkflowDiff; path?: string }) {
  const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set());
  let no = 0;
  const rows: Row[] = diff.lines.map((line) => (line.op === "-" ? { ...line } : { ...line, no: ++no }));
  const tokens = useTokens(rows.map((r) => r.text).join("\n"), langOf(path));
  const added = rows.filter((r) => r.op === "+").length;
  const removed = rows.filter((r) => r.op === "-").length;
  const pieces = piecesOf(rows, opened);
  return (
    <CodeFrame path={path} meta={`${added} added, ${removed} removed`}>
      {(diff.isNew || diff.cut || (added === 0 && removed === 0)) && (
        <p className="border-b border-line px-3 py-1.5 text-xs text-muted">
          {diff.isNew ? "You never approved this file, so every line is new. " : ""}
          {added === 0 && removed === 0 ? "Nothing changed since you approved it. " : ""}
          {diff.cut ? "The diff stops at 200 lines. Open the file to read the rest." : ""}
        </p>
      )}
      <ScrollBox label={path ? `Changes to ${fileName(path)} since you approved` : "Changes since you approved"} maxHeight={560}>
        <div className="w-max min-w-full py-2 font-mono text-xs leading-[1.6] tabular-nums">
          {pieces.map((piece) => {
            if (piece.kind === "gap") {
              const count = piece.to - piece.from;
              return (
                <button
                  key={`gap-${piece.from}`}
                  type="button"
                  onClick={() => setOpened((prev) => new Set(prev).add(piece.from))}
                  className="flex w-full text-left font-sans text-xs text-muted hover:bg-hover hover:text-fg max-[699px]:min-h-10 max-[699px]:items-center"
                >
                  <span className="w-12 flex-none" />
                  <span className="pr-4">{count} lines without changes</span>
                </button>
              );
            }
            const row = rows[piece.at]!;
            return (
              <div key={piece.at} data-op={row.op === "+" ? "added" : row.op === "-" ? "removed" : "same"} className={`flex ${TINT[row.op]}`}>
                <span aria-hidden="true" className="w-12 flex-none pr-3 text-right text-muted select-none">
                  {row.no ?? ""}
                </span>
                <span aria-hidden="true" className="w-4 flex-none text-muted select-none">
                  {SIGN[row.op]}
                </span>
                <span className="pr-4 whitespace-pre">
                  {SAID[row.op] && <span className="sr-only">{SAID[row.op]}</span>}
                  <TokenLine tokens={tokens?.[piece.at]} text={row.text} />
                </span>
              </div>
            );
          })}
        </div>
      </ScrollBox>
    </CodeFrame>
  );
}
