import { CodeBlock } from "../ui/code-block.tsx";
import { DiffView } from "../ui/diff-view.tsx";
import { Markdown, MarkdownBlock } from "../ui/markdown.tsx";
import { ANSWER_TEXT, NEW_DIFF, SKILL_PATH, SKILL_TEXT, WORKFLOW_DIFF, WORKFLOW_PATH, WORKFLOW_TEXT } from "./kit-data.ts";
import { KitGroup, KitSection } from "./kit-section.tsx";

/** Markdown, rendered or raw, with code highlighted by Shiki, and the diff of a workflow file. */
export function MarkdownSection() {
  return (
    <KitSection id="kit-markdown" title="Markdown and code">
      <KitGroup title="Markdown" note="A step's answer, 14px on 1.6, at most 72 characters a line. A link out of sous opens in a new tab.">
        <Markdown>{ANSWER_TEXT}</Markdown>
      </KitGroup>
      <KitGroup title="Markdown file" note="A skill file. Frontmatter shows as a small table, and Rendered and Raw sit at the top right of the box.">
        <div className="max-w-[720px]">
          <MarkdownBlock path={SKILL_PATH} text={SKILL_TEXT} />
        </div>
      </KitGroup>
      <KitGroup title="Code" note="Plain text at once, colored once Shiki loads. Grays only: strings and comments muted, keywords in 500.">
        <CodeBlock code={WORKFLOW_TEXT} path={WORKFLOW_PATH} />
      </KitGroup>
      <KitGroup title="Changes since you approved" note="Added lines on a gray tint, removed ones on red. Unchanged runs fold into a row that opens.">
        <div className="flex flex-col gap-4">
          <DiffView diff={WORKFLOW_DIFF} path={WORKFLOW_PATH} />
          <DiffView diff={NEW_DIFF} path="/Users/maya/code/billing/.sous/workflows/hello.js" />
        </div>
      </KitGroup>
    </KitSection>
  );
}
