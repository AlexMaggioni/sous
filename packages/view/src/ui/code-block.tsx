// A file or a snippet in mono with line numbers, plain at once and highlighted once shiki loads.
import type { ReactNode } from "react";
import { lineCount, plural } from "../format.ts";
import { CopyButton } from "./copy.tsx";
import { langOf, useTokens, type Token } from "./highlight.ts";
import { ScrollBox } from "./scroll-area.tsx";

/** A line's tokens, or its plain text while they load. */
export function TokenLine({ tokens, text }: { tokens: Token[] | undefined; text: string }) {
  if (!tokens) return <>{text}</>;
  return (
    <>
      {tokens.map((t, i) => (
        <span key={i} style={t.color ? { color: t.color } : undefined} className={`${t.italic ? "italic" : ""} ${t.strong ? "font-medium" : ""}`}>
          {t.text}
        </span>
      ))}
    </>
  );
}

/**
 * The lines of a file, with numbers. `wrap` breaks long lines instead of scrolling sideways, for
 * prose such as markdown. `label` names the scroll region for screen readers. Each row carries its
 * number in `data-line`, so a page can mark one.
 */
export function CodeLines({ code, lang, wrap = false, label }: { code: string; lang?: string; wrap?: boolean; label: string }) {
  const text = code.replace(/\n$/, "");
  const lines = text.split("\n");
  const tokens = useTokens(text, langOf(lang));
  const body = (
    <div className={`py-2 font-mono text-xs leading-[1.6] tabular-nums ${wrap ? "" : "w-max min-w-full"}`} data-highlighted={tokens ? "" : undefined}>
      {lines.map((line, i) => (
        <div key={i} data-line={i + 1} className="flex">
          <span aria-hidden="true" className="w-12 flex-none pr-3 text-right text-muted select-none">
            {i + 1}
          </span>
          <span className={`pr-4 ${wrap ? "min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]" : "whitespace-pre"}`}>
            <TokenLine tokens={tokens?.[i]} text={line} />
          </span>
        </div>
      ))}
    </div>
  );
  return wrap ? (
    <div role="region" aria-label={label} tabIndex={0} className="max-h-[560px] overflow-y-auto">
      {body}
    </div>
  ) : (
    <ScrollBox label={label} maxHeight={560}>
      {body}
    </ScrollBox>
  );
}

/** A box with the path, the line count and a copy button above the lines. */
export function CodeFrame({ path, meta, copy, children }: { path?: string; meta: ReactNode; copy?: string; children: ReactNode }) {
  return (
    <div className="max-w-full min-w-0 overflow-hidden rounded-lg border border-line bg-raised">
      <div className="flex min-h-8 items-center gap-2 border-b border-line pr-1 pl-3 text-xs text-muted">
        <span className="min-w-0 flex-1 truncate font-mono">{path}</span>
        <span className="flex-none">{meta}</span>
        {copy !== undefined && <CopyButton text={copy} label="Copy the file" />}
        {copy === undefined && <span className="h-6" />}
      </div>
      {children}
    </div>
  );
}

/** A file's text, such as a workflow's source. The language comes from `lang`, else from the path. */
export function CodeBlock({ code, path, lang, wrap = false }: { code: string; path?: string; lang?: string; wrap?: boolean }) {
  return (
    <CodeFrame path={path} meta={plural(lineCount(code), "line")} copy={code}>
      <CodeLines code={code} lang={lang ?? path} wrap={wrap} label={path ? `Text of ${path}` : "Code"} />
    </CodeFrame>
  );
}
