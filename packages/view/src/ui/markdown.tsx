// Markdown, such as a skill, an agent or a step's answer: rendered at 14px, with its raw text one press away.
import { useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeFrame, CodeLines, TokenLine } from "./code-block.tsx";
import { langOf, useTokens } from "./highlight.ts";
import { ScrollBox } from "./scroll-area.tsx";
import { Segmented } from "./segmented.tsx";

// A node of the markdown tree, as react-markdown hands it to a component.
type MdNode = { type: string; tagName?: string; value?: string; children?: MdNode[] };

const textOf = (node: MdNode): string => (node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(textOf).join(""));
const cellsOf = (node: MdNode): MdNode[] => (node.tagName === "th" ? [node] : (node.children ?? []).flatMap(cellsOf));

/** A fenced block inside markdown: no line numbers, on the page's own fill. */
function Snippet({ code, lang }: { code: string; lang?: string }) {
  const text = code.replace(/\n$/, "");
  const tokens = useTokens(text, langOf(lang));
  // A screen reader lists each scroll box by its name, so the name starts with the first line.
  const first = text.split("\n")[0]?.trim().slice(0, 48);
  return (
    <div className="my-2 overflow-hidden rounded-md border border-line bg-base">
      <ScrollBox label={`Code${lang ? ` in ${lang}` : ""}${first ? `: ${first}` : ""}`}>
        <pre className="m-0 w-max min-w-full px-3 py-2 font-mono text-xs leading-[1.55]" data-highlighted={tokens ? "" : undefined}>
          {text.split("\n").map((line, i) => (
            <div key={i}>
              <TokenLine tokens={tokens?.[i]} text={line} />
            </div>
          ))}
        </pre>
      </ScrollBox>
    </div>
  );
}

const COMPONENTS: Components = {
  pre({ node, children }) {
    const code = node?.children[0];
    if (code?.type !== "element" || code.tagName !== "code") return <pre>{children}</pre>;
    const classes = Array.isArray(code.properties.className) ? code.properties.className.map(String) : [];
    const lang = classes.find((c) => c.startsWith("language-"))?.slice("language-".length);
    const text = code.children.map((child) => (child.type === "text" ? child.value : "")).join("");
    return <Snippet code={text} lang={lang} />;
  },
  table({ node, children }) {
    const heads = node ? cellsOf(node).map(textOf).filter(Boolean) : [];
    return (
      <div className="my-2">
        <ScrollBox label={heads.length ? `Table of ${heads.join(", ")}` : "Table"}>
          <table>{children}</table>
        </ScrollBox>
      </div>
    );
  },
  // A task list item wraps its checkbox and its text in a label, so the checkbox has a name.
  li({ className, children }) {
    if (!className?.includes("task-list-item")) return <li className={className}>{children}</li>;
    return (
      <li className={className}>
        <label>{children}</label>
      </li>
    );
  },
  a({ href, children }) {
    const outside = !!href && /^https?:/.test(href);
    return (
      <a href={href} {...(outside ? { target: "_blank", rel: "noreferrer" } : {})}>
        {children}
      </a>
    );
  },
};

/** The frontmatter of an agent or skill file, split from its body. */
function splitFrontmatter(text: string): { fields: [string, string][]; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { fields: [], body: text };
  const fields = m[1]!
    .split(/\r?\n/)
    .filter((line) => line.includes(":"))
    .map((line): [string, string] => {
      const at = line.indexOf(":");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    });
  return { fields, body: m[2]! };
}

/** Rendered markdown with GitHub's tables, task lists and strikethrough. Raw HTML stays text. Frontmatter shows as a small table. */
export function Markdown({ children }: { children: string }) {
  const { fields, body } = splitFrontmatter(children);
  return (
    <div className="prose">
      {fields.length > 0 && (
        <table className="frontmatter">
          <tbody>
            {fields.map(([key, value]) => (
              <tr key={key}>
                <th scope="row">{key}</th>
                <td>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {body}
      </ReactMarkdown>
    </div>
  );
}

type View = "rendered" | "raw";
const VIEWS = [
  { value: "rendered", label: "Rendered" },
  { value: "raw", label: "Raw" },
] as const;

/** A markdown file in a box: its path at the top left, and Rendered and Raw at the top right. */
export function MarkdownBlock({ path, text }: { path: string; text: string }) {
  const [view, setView] = useState<View>("rendered");
  return (
    <CodeFrame path={path} meta={<Segmented label={`Show ${path} as`} value={view} onChange={setView} options={VIEWS} size="sm" />}>
      {view === "rendered" ? (
        <div className="px-4 pt-1 pb-3">
          <Markdown>{text}</Markdown>
        </div>
      ) : (
        <CodeLines code={text} lang="markdown" wrap label={`Text of ${path}`} />
      )}
    </CodeFrame>
  );
}
