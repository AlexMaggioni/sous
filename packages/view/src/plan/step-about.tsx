// What a step is, for the panel under the Graph and Steps views, in two parts. The main part says
// what it does in the words of its kind, such as an agent's prompt or a command's code. The side
// part holds its settings, where it sits in the plan and the line of the text it comes from. The
// same on a workflow's page and on a run's.
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { AgentPage, Flow, FlowNode, FlowStep } from "../api/contract.ts";
import { useAgent, useWorkflows } from "../api/queries.ts";
import { useProjectSearch } from "../api/seen-from.ts";
import type { Part, Seq } from "../graph/tree.ts";
import { HARNESS_NAME } from "../lists/catalog-rows.ts";
import { placeWords } from "../pages/workflow/workflow-words.ts";
import type { ProjectSearch } from "../router.tsx";
import { lineCount, plural } from "../format.ts";
import { CodeFrame, CodeLines } from "../ui/code-block.tsx";
import { aroundOf, insideOf, readsOf, textOf, type Read, type Ref } from "./plan.ts";

const LINK = "rounded-sm underline decoration-1 underline-offset-2 hover:text-fg";

/** A small heading over a part of the panel. */
export function PanelPart({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <div className="mt-5 first:mt-0">
      <h3 className="mb-1.5 flex items-baseline gap-2 text-xs font-medium text-muted">
        <span className="flex-1">{title}</span>
        {meta && <span className="font-normal">{meta}</span>}
      </h3>
      {children}
    </div>
  );
}

type Pair = [label: string, value: ReactNode, from?: string];

/** Label and value pairs, each with where its value comes from, such as "from the agent". Empty values drop out. */
export function Pairs({ pairs }: { pairs: (Pair | null | false | undefined)[] }) {
  const shown = pairs.filter((p): p is Pair => !!p && p[1] !== undefined && p[1] !== null && p[1] !== "");
  if (!shown.length) return null;
  return (
    <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
      {shown.map(([label, value, from]) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]">
            {value}
            {from && <span className="text-muted"> {from}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A part the words point to, as a button that selects it. */
function RefButton({ to, onSelect }: { to: Ref; onSelect: (key: string) => void }) {
  if (!to.key) return <span className="font-mono text-xs">{to.name}</span>;
  return (
    <button type="button" onClick={() => onSelect(to.key)} className={`font-mono text-xs ${LINK}`}>
      {to.name}
    </button>
  );
}

function RefList({ refs, onSelect, max = 6 }: { refs: Ref[]; onSelect: (key: string) => void; max?: number }) {
  const shown = refs.slice(0, max);
  return (
    <>
      {shown.map((r, i) => (
        <span key={`${r.key} ${i}`}>
          {i > 0 && ", "}
          <RefButton to={r} onSelect={onSelect} />
        </span>
      ))}
      {refs.length > max && <span className="text-muted">, and {refs.length - max} more</span>}
    </>
  );
}

const list = (items: readonly string[] | undefined) => (items?.length ? items.join(", ") : undefined);

/**
 * A prompt as the text writes it. Each {expression} shows as code, and one that reads an earlier
 * step's result links to that step.
 */
function PromptText({ text, reads, onSelect }: { text: string; reads: Read[]; onSelect: (key: string) => void }) {
  const parts = text.split(/(\{[^{}\n]+\})/g);
  return (
    <div className="max-h-[320px] overflow-auto rounded-lg border border-line bg-base px-3 py-2 text-sm leading-[1.55] whitespace-pre-wrap [overflow-wrap:anywhere]">
      {parts.map((piece, i) => {
        if (!/^\{[^{}\n]+\}$/.test(piece)) return <span key={i}>{piece}</span>;
        const source = piece.slice(1, -1);
        const root = /^[A-Za-z_$][\w$]*/.exec(source)?.[0];
        const read = reads.find((r) => r.ref?.key && r.name === root);
        const look = "rounded-sm bg-hover px-1 font-mono text-xs";
        return read?.ref ? (
          <button key={i} type="button" onClick={() => onSelect(read.ref!.key)} className={`${look} underline decoration-1 underline-offset-2`}>
            {source}
          </button>
        ) : (
          <code key={i} className={look}>
            {source}
          </code>
        );
      })}
    </div>
  );
}

/** A setting of an agent step: the step's own, else the agent's, else the harness's default. */
function fromWhich<T>(step: T | undefined, agent: T | undefined): [T | undefined, string | undefined] {
  if (step !== undefined) return [step, "from the step"];
  if (agent !== undefined) return [agent, "from the agent"];
  return [undefined, undefined];
}

/** What the main part and the side part of the panel say about a step. */
export type About = { main: ReactNode; side: ReactNode };

/** `search` opens the agent as seen from the project the panel reads. */
function agentAbout(node: FlowStep, agent: AgentPage | undefined, reads: Read[], onSelect: (key: string) => void, search: ProjectSearch): About {
  const o = node.options ?? {};
  const own = agent?.settings[0];
  const [model, modelFrom] = fromWhich(node.model, own?.model);
  const [effort, effortFrom] = fromWhich(o.effort, own?.effort);
  const [mode, modeFrom] = fromWhich(o.mode, own?.mode);
  const [timeout, timeoutFrom] = fromWhich(o.timeout, agent?.timeout);
  const skills = [...(o.skills ?? []), ...(own?.skills ?? []).filter((s) => !o.skills?.includes(s))];
  const mcp = [...(o.mcp ?? []), ...(own?.mcp ?? []).filter((s) => !o.mcp?.includes(s))];
  const main = (
    <>
      <PanelPart title="Agent">
        {node.agent ? (
          <p>
            <Link to="/agents/$name" params={{ name: node.agent }} search={search} className={`font-medium ${LINK}`}>
              {node.agent}
            </Link>
            {agent?.description && <span className="block text-pretty text-muted">{agent.description}</span>}
          </p>
        ) : (
          <p className="text-muted">No agent named. The harness runs the prompt as it is.</p>
        )}
      </PanelPart>
      {node.prompt && (
        <PanelPart title="Prompt" meta={node.result ? `Its answer is ${node.result}` : undefined}>
          <PromptText text={node.prompt} reads={reads} onSelect={onSelect} />
        </PanelPart>
      )}
    </>
  );
  const side = (
    <PanelPart title="Settings">
      <Pairs
        pairs={[
          ["Model", model ?? "The harness's default", modelFrom],
          ["Effort", effort, effortFrom],
          ["Harness", agent ? HARNESS_NAME[agent.harness] : undefined, agent ? "from the agent" : undefined],
          ["Mode", mode, modeFrom],
          ["Tools", own ? (own.tools === "all" ? "All" : (list(own.tools) ?? "None")) : undefined],
          ["Skills", list(skills)],
          ["MCP", list(mcp)],
          ["Retries", node.retries ? `Up to ${node.retries}` : undefined],
          ["Timeout", timeout, timeoutFrom],
          ["Returns", o.schema?.length ? <span className="font-mono text-xs">{o.schema.join(", ")}</span> : undefined],
          ["Session", o.continues ? `Goes on in the session of ${o.continues}` : o.keepSession ? "Keeps its session for a later step" : undefined],
          ["Asks you", o.asks ? (o.answeredBy === "anyone" ? "It may ask, and anyone may answer" : "It may stop to ask you") : undefined],
          ["Works in", o.isolation === "worktree" ? "A worktree of its own" : undefined],
        ]}
      />
    </PanelPart>
  );
  return { main, side };
}

const CODE_TITLE: Record<string, string> = {
  sh: "Command",
  wait: "Check",
  js: "Source",
  py: "Source",
  run: "File",
};
const CODE_LANG: Record<string, string> = { sh: "sh", wait: "sh", js: "js" };

function codeAbout(node: FlowStep): About {
  const o = node.options ?? {};
  const main = node.code && (
    <PanelPart title={CODE_TITLE[node.kind] ?? "Code"}>
      <CodeFrame meta={plural(lineCount(node.code), "line")} copy={node.code}>
        <CodeLines code={node.code} lang={CODE_LANG[node.kind]} wrap label={`${CODE_TITLE[node.kind] ?? "Code"} of ${node.label}`} />
      </CodeFrame>
    </PanelPart>
  );
  const side = (
    <Pairs
      pairs={[
        ["Checks", o.every ? `Every ${o.every}` : undefined],
        ["On failure", o.allowFail ? "The run goes on" : undefined],
        ["Retries", node.retries ? `Up to ${node.retries}` : undefined],
        ["Timeout", o.timeout],
        ["Returns", node.result ? <span className="font-mono text-xs">{node.result}</span> : undefined],
      ]}
    />
  );
  return { main, side };
}

const ANSWER: Record<string, string> = {
  confirm: "Yes or no",
  input: "Free text",
  select: "One of the choices",
};

function askAbout(node: FlowStep, inside: Ref[], onSelect: (key: string) => void): About {
  const o = node.options ?? {};
  if (node.kind === "breakpoint") {
    return {
      main: (
        <Pairs
          pairs={[
            ["Runs first", inside.length ? <RefList refs={inside} onSelect={onSelect} /> : undefined],
            ["Then", "Waits for your yes. You approve, stop the run, or send it back with a note."],
          ]}
        />
      ),
      side: <Pairs pairs={[["Send back", o.max ? `Up to ${plural(o.max, "time")}` : undefined]]} />,
    };
  }
  return {
    main: (
      <Pairs
        pairs={[
          ["Question", node.prompt && node.prompt !== node.label ? node.prompt : undefined],
          ["Choices", list(o.choices)],
          ["Answer", o.answer ? ANSWER[o.answer] : o.choices?.length ? ANSWER.select : undefined],
        ]}
      />
    ),
    side: (
      <Pairs
        pairs={[
          ["Answered by", o.answeredBy === "anyone" ? "People or an agent" : "People only"],
          ["Timeout", o.timeout],
        ]}
      />
    ),
  };
}

function WorkflowAbout({ node, project }: { node: FlowStep; project?: string }) {
  const rows = useWorkflows(project).data;
  const search = useProjectSearch(project);
  const o = node.options ?? {};
  const name = node.workflow;
  const description = rows?.find((w) => w.name === name)?.description;
  return (
    <>
      <PanelPart title="Workflow">
        {name ? (
          <p>
            <Link to="/workflows/$name" params={{ name }} search={search} className={`font-medium ${LINK}`}>
              {name}
            </Link>
            {description && <span className="block text-pretty text-muted">{description}</span>}
          </p>
        ) : (
          <p className="text-muted">Its name is made at run time.</p>
        )}
      </PanelPart>
      {o.inputs && Object.keys(o.inputs).length > 0 && (
        <PanelPart title="Inputs">
          <Pairs pairs={Object.entries(o.inputs).map(([k, v]): Pair => [k, <code className="text-xs">{v}</code>])} />
        </PanelPart>
      )}
    </>
  );
}

function workflowAbout(node: FlowStep, project: string | undefined): About {
  const place = node.options?.place ? placeWords(node.options.place) : undefined;
  return {
    main: <WorkflowAbout node={node} project={project} />,
    side: (
      <Pairs
        pairs={[
          ["Works in", place?.value],
          ["Returns", node.result ? <span className="font-mono text-xs">{node.result}</span> : undefined],
        ]}
      />
    ),
  };
}

function chooseAbout(node: FlowStep, reads: Read[], onSelect: (key: string) => void): About {
  const o = node.options ?? {};
  const picks = o.any ? "Any saved workflow" : list([...(o.steps ?? []), ...(o.workflows ?? [])]);
  return {
    main: node.prompt && (
      <PanelPart title="Prompt">
        <PromptText text={node.prompt} reads={reads} onSelect={onSelect} />
      </PanelPart>
    ),
    side: (
      <Pairs
        pairs={[
          ["Picks from", picks],
          ["Model", node.model],
        ]}
      />
    ),
  };
}

/** The sentence that says what a group does. */
function groupSentence(part: Part, node: FlowNode | undefined): string {
  if (part.t === "box" && node?.t === "loop") {
    const limit = node.limit ? `up to ${node.limit} times` : "up to 3 times";
    if (node.loop === "gate") return `Runs the steps inside, then checks the result${node.until ? ` with ${node.until}` : ""}. While the check fails, it runs them again, ${limit}.`;
    if (node.loop === "retry") return `Runs the steps inside, and again when they fail${node.until ? ` or ${node.until} says no` : ""}, ${limit}.`;
    if (node.loop === "for") return `Runs the steps inside once for each ${node.label ?? "item"}, one after the other.`;
    return `Runs the steps inside again while ${node.label ?? "its condition holds"}.`;
  }
  if (part.t === "box" && part.kind === "pipeline") return `Takes each of ${part.title} through the steps inside. The items run at the same time, each through every stage in order.`;
  if (part.t === "par")
    return part.conds ? `Runs one branch: the first ${part.conds[0]}, else the second.` : `Runs ${plural(part.lanes.length, "branch", "branches")} at the same time, and goes on once every one ends.`;
  if (part.t === "iff") return `Runs the steps inside only ${part.label}.`;
  if (part.t === "ret") return `Ends the workflow here if ${part.edge}.`;
  if (part.t === "end") return "The workflow ends here.";
  return "";
}

export type AboutProps = {
  part: Part;
  node: FlowNode | undefined;
  flow?: Flow;
  flows?: Record<string, Flow>;
  graph: Seq;
  /** The project the catalogs are read from, for the agent and the workflow a step names. Their links open them as seen from it. */
  project?: string;
  onSelect: (key: string) => void;
  /** Shows the line in the text. */
  onLine?: (line: number, flow: string | undefined) => void;
  /** The name of the file the root's text is in. */
  file?: string;
};

/** What the step is, in its main part, then its settings, where it sits and its line in the text, in its side part. */
export function useStepAbout({ part, node, flow, flows, graph, project, onSelect, onLine, file }: AboutProps): About {
  const step = node?.t === "step" ? node : undefined;
  const text = textOf(part, flow, flows);
  const flowName = "flow" in part ? part.flow : undefined;
  const { reads, readBy } = step && text ? readsOf(step, text, graph, flowName) : { reads: [], readBy: [] };
  const agentName = step?.kind === "agent" ? step.agent : undefined;
  const agent = useAgent(agentName ?? "", project, !!agentName).data;
  const search = useProjectSearch(project);
  const inside = insideOf(part);
  const around = aroundOf(graph, part.key);
  const sentence = groupSentence(part, node);
  let kind: About = { main: null, side: null };
  if (step?.kind === "agent") kind = agentAbout(step, step.agent ? agent : undefined, reads, onSelect, search);
  else if (step && ["sh", "js", "py", "run", "wait"].includes(step.kind)) kind = codeAbout(step);
  else if (step && ["ask", "checkpoint", "breakpoint"].includes(step.kind)) kind = askAbout(step, inside, onSelect);
  else if (step?.kind === "workflow") kind = workflowAbout(step, project);
  else if (step?.kind === "choose") kind = chooseAbout(step, reads, onSelect);
  const line = node?.line;
  const main = (
    <div className="flex flex-col">
      {sentence && <p className="mb-4 max-w-[70ch] text-pretty">{sentence}</p>}
      {kind.main}
      {inside.length > 0 && step?.kind !== "breakpoint" && (
        <PanelPart title="Inside" meta={plural(inside.length, "step")}>
          <ul className="flex flex-col gap-1">
            {inside.slice(0, 12).map((r) => (
              <li key={r.key}>
                <RefButton to={r} onSelect={onSelect} />
              </li>
            ))}
            {inside.length > 12 && <li className="text-muted">and {inside.length - 12} more</li>}
          </ul>
        </PanelPart>
      )}
    </div>
  );
  const side = (
    <div className="flex flex-col">
      {kind.side}
      <PanelPart title="Where it sits">
        <Pairs
          pairs={[
            ["After", around.first ? "The start" : around.after.length ? <RefList refs={around.after} onSelect={onSelect} /> : undefined],
            ["Alongside", around.alongside.length ? <RefList refs={around.alongside} onSelect={onSelect} /> : undefined],
            ["Then", around.last ? "The end" : around.then.length ? <RefList refs={around.then} onSelect={onSelect} /> : undefined],
            [
              "Reads",
              reads.length
                ? reads.map((r, i) => (
                    <span key={r.name}>
                      {i > 0 && ", "}
                      {r.ref ? <RefButton to={{ ...r.ref, name: r.name }} onSelect={onSelect} /> : <span className="font-mono text-xs">{r.name}</span>}
                    </span>
                  ))
                : undefined,
            ],
            ["Read by", readBy.length ? <RefList refs={readBy} onSelect={onSelect} /> : undefined],
            ["Phase", step?.phase],
          ]}
        />
      </PanelPart>
      {line !== undefined && onLine && (
        <p className="mt-4 text-xs text-muted">
          <button type="button" onClick={() => onLine(line, flowName)} className={LINK}>
            Line {line} of {flowName ? `the workflow ${flowName}` : (file ?? "the text")}
          </button>
        </p>
      )}
    </div>
  );
  return { main, side };
}
