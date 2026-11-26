// A markdown text in its box, read rendered or raw, with the switch at the top right, the same on
// the agent, skill and every other page that shows one. Rendered shows the markdown alone. Raw shows
// the whole file as sous reads it, front matter and all.
import { useState } from "react";
import { CodeFrame, CodeLines } from "../../ui/code-block.tsx";
import { fileName } from "../../ui/facts.tsx";
import { Markdown } from "../../ui/markdown.tsx";
import { Segmented } from "../../ui/segmented.tsx";

type View = "rendered" | "raw";
const VIEWS = [
  { value: "rendered", label: "Rendered" },
  { value: "raw", label: "Raw" },
] as const;

/** `rendered` is the markdown to draw, `raw` the file's whole text. The box names the file by its name. */
export function SourceBlock({ file, rendered, raw }: { file: string; rendered: string; raw: string }) {
  const [view, setView] = useState<View>("rendered");
  const name = fileName(file);
  return (
    <CodeFrame path={name} meta={<Segmented label={`Show ${name} as`} value={view} onChange={setView} options={VIEWS} size="sm" />} copy={raw}>
      {view === "rendered" ? (
        <div className="px-4 pt-3 pb-4">{rendered.trim() ? <Markdown>{rendered}</Markdown> : <p className="text-muted">The file has no text under its front matter.</p>}</div>
      ) : (
        <CodeLines code={raw} lang={file} wrap label={`Text of ${name}`} />
      )}
    </CodeFrame>
  );
}
