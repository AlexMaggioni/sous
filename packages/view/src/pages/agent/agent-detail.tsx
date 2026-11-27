// An agent: its prompt, its tools and its MCP servers on the left, since they make the agent, and
// its settings and where it lives on the right. A setting that differs on the other harness shows
// under the default one's value, as DESIGN.md asks, with no harness tabs.
import { Link, useParams, useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { AgentPage, AgentSettings, Harness } from "../../api/contract.ts";
import { useAgent, useMcp } from "../../api/queries.ts";
import { usePageProject, useProjectName, useProjectSearch } from "../../api/seen-from.ts";
import { HARNESS_NAME } from "../../lists/catalog-rows.ts";
import type { ProjectSearch } from "../../router.tsx";
import { Path, type Fact } from "../../ui/facts.tsx";
import { Banner, DetailFailed, DetailLoading, DetailPage, isMissing, LINK, None, Section, Stack } from "../detail/detail-page.tsx";
import { placeOf } from "../detail/detail-words.ts";
import { SourceBlock } from "../detail/source-block.tsx";

/** Names as mono tokens, such as a tool list. */
function Tokens({ names }: { names: readonly string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {names.map((name) => (
        <code key={name} className="rounded-sm bg-hover px-1.5 py-px">
          {name}
        </code>
      ))}
    </span>
  );
}

const toolsText = (s: AgentSettings) => (s.tools === "all" ? "all" : s.tools.join(","));

function ToolsOf({ settings }: { settings: AgentSettings }) {
  if (settings.tools !== "all" && settings.tools.length) return <Tokens names={settings.tools} />;
  return <span>Every tool{settings.harness === "codex" ? ". Codex agents have no tool list." : ""}</span>;
}

function Tools({ settings }: { settings: AgentSettings[] }) {
  const [main, other] = settings;
  const refused = settings.filter((s) => s.disallowedTools?.length);
  const rows: Array<{ label: string; value: ReactNode }> = [];
  if (other && toolsText(main!) !== toolsText(other)) for (const s of settings) rows.push({ label: HARNESS_NAME[s.harness], value: <ToolsOf settings={s} /> });
  for (const s of refused) rows.push({ label: refused.length > 1 || other ? `Refuses on ${HARNESS_NAME[s.harness]}` : "Refuses", value: <Tokens names={s.disallowedTools!} /> });
  if (!rows.length) return <ToolsOf settings={main!} />;
  const first = rows.length === refused.length ? [{ label: "Allows", value: <ToolsOf settings={main!} /> }] : [];
  return (
    <dl className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-6 gap-y-2 max-[699px]:grid-cols-1 max-[699px]:gap-y-1">
      {[...first, ...rows].map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-muted max-[699px]:mt-2">{row.label}</dt>
          <dd className="min-w-0">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One MCP server the agent lists: its name linked, how sous reaches it, and a note when it applies. */
function McpLine({ name, harness, project }: { name: string; harness: Harness; project?: string }) {
  const server = useMcp(name, project);
  const search = useProjectSearch(project);
  const missing = isMissing(server.error);
  const s = server.data;
  const how = s ? (s.type === "stdio" ? [s.command, ...(s.args ?? [])].filter(Boolean).join(" ") : s.url) : undefined;
  const note = missing ? "No MCP file sous reads has it, so steps run without it." : s && !s.seenBy.includes(harness) ? `${HARNESS_NAME[harness]} steps don't see it.` : undefined;
  return (
    <div className="contents">
      <dt className="max-[699px]:mt-2">
        {missing ? (
          <span>{name}</span>
        ) : (
          <Link to="/mcp/$name" params={{ name }} search={search} className={LINK}>
            {name}
          </Link>
        )}
      </dt>
      <dd className="min-w-0">
        {server.isPending && <span className="text-muted">Reading</span>}
        {s && (
          <span className="[overflow-wrap:anywhere]">
            {s.type} {how && <code>{how}</code>}
          </span>
        )}
        {missing && <span className="text-fail">Not found</span>}
        {server.error && !missing && <span className="text-muted">sous could not read it</span>}
        {note && <span className="block text-xs text-muted">{note}</span>}
      </dd>
    </div>
  );
}

function McpServers({ agent, project }: { agent: AgentPage; project?: string }) {
  const main = agent.settings[0]!;
  const names = main.mcp ?? [];
  if (!names.length) return <None>None</None>;
  return (
    <dl className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-6 gap-y-2 max-[699px]:grid-cols-1 max-[699px]:gap-y-1">
      {names.map((name) => (
        <McpLine key={name} name={name} harness={main.harness} project={project} />
      ))}
    </dl>
  );
}

function SkillLinks({ names, search }: { names: readonly string[]; search: ProjectSearch }) {
  return (
    <Stack>
      {names.map((name) => (
        <Link key={name} to="/skills/$name" params={{ name }} search={search} className={LINK}>
          {name}
        </Link>
      ))}
    </Stack>
  );
}

/** A setting's words on one harness. Codex lists no skills, so it sees every skill it finds. */
function settingOf(s: AgentSettings, field: "model" | "effort" | "skills", search: ProjectSearch): { text: string; node: ReactNode } {
  if (field === "skills") {
    if (s.skills?.length) return { text: s.skills.join(","), node: <SkillLinks names={s.skills} search={search} /> };
    return s.harness === "codex" ? { text: "codex", node: "Every skill Codex finds" } : { text: "", node: <None /> };
  }
  const value = s[field];
  return value ? { text: value, node: value } : { text: "", node: <None>Default</None> };
}

/** The default harness's value, and the other one's under it only where it differs. */
function settingFact(label: string, settings: AgentSettings[], field: "model" | "effort" | "skills", search: ProjectSearch): Fact {
  const [main, other] = settings;
  const a = settingOf(main!, field, search);
  const b = other && settingOf(other, field, search);
  return {
    label,
    value: a.node,
    sub: b && b.text !== a.text ? (
      <>
        {HARNESS_NAME[other!.harness]}: {b.node}
      </>
    ) : undefined,
  };
}

/** `search` keeps the page's project on its links. */
function agentFacts(agent: AgentPage, search: ProjectSearch): Fact[] {
  const { settings } = agent;
  const [main, other] = settings;
  const claude = settings.find((s) => s.harness === "claude");
  const facts: Fact[] = [
    other
      ? { label: "Runs on", value: `${HARNESS_NAME[main!.harness]} and ${HARNESS_NAME[other.harness]}`, sub: `${HARNESS_NAME[main!.harness]} unless a step picks ${HARNESS_NAME[other.harness]}` }
      : { label: "Runs on", value: `${HARNESS_NAME[agent.harness]} only`, sub: agent.from === "rulesync" ? undefined : `It lives in ${HARNESS_NAME[agent.from]}'s own folder` },
    settingFact("Model", settings, "model", search),
    settingFact("Effort", settings, "effort", search),
  ];
  if (claude) facts.push({ label: "Permission mode", value: claude.mode ?? <None>Default</None>, sub: other ? "Claude Code only" : undefined });
  facts.push(
    settingFact("Skills", settings, "skills", search),
    { label: "Place", value: agent.place === "worktree" ? "A worktree of its own" : <None>The run's folder</None> },
    { label: "Timeout", value: agent.timeout ? <span className="tabular-nums">{agent.timeout}</span> : <None /> },
    {
      label: "Used by",
      value: agent.usedBy.length ? (
        <Stack>
          {agent.usedBy.map((use) => (
            <span key={`${use.workflow}:${use.step}`}>
              <span className="font-mono text-xs">{use.step}</span>
              <span className="text-muted"> in </span>
              <Link to="/workflows/$name" params={{ name: use.workflow }} search={search} className={LINK}>
                {use.workflow}
              </Link>
            </span>
          ))}
        </Stack>
      ) : (
        <None>No step</None>
      ),
    },
    { label: "File", value: <Path path={agent.file} />, sub: placeOf(agent.scope, agent.from) },
    {
      label: "Other copies",
      value: agent.copies.length ? (
        <Stack>
          {agent.copies.map((copy) => (
            <span key={copy.file} className="text-muted">
              <Path path={copy.file} />
              <span className="block text-xs">{placeOf(copy.scope, copy.from)}, not used</span>
            </span>
          ))}
        </Stack>
      ) : (
        <None />
      ),
    },
  );
  return facts;
}

function Loaded({ agent, project }: { agent: AgentPage; project?: string }) {
  const search = useProjectSearch(project);
  return (
    <DetailPage
      section="agents"
      name={agent.name}
      description={agent.description}
      banners={agent.problem && <Banner tone="failed" title="A step can't use it as it is.">{agent.problem}</Banner>}
      facts={agentFacts(agent, search)}
    >
      <Section title="Prompt">
        <SourceBlock file={agent.file} rendered={agent.prompt} raw={agent.raw} />
      </Section>
      <Section title="Tools">
        <Tools settings={agent.settings} />
      </Section>
      <Section title="MCP servers">
        <McpServers agent={agent} project={project} />
      </Section>
    </DetailPage>
  );
}

/** One agent, at #/agents/$name, as sous finds it from the project its link names, else the one the lists are seen from. */
export function AgentDetail() {
  const { name } = useParams({ from: "/agents/$name" });
  const project = usePageProject(useSearch({ from: "/agents/$name" }).project);
  const seen = useProjectName(project);
  const agent = useAgent(name, project);
  if (agent.isPending) return <DetailLoading section="agents" name={name} />;
  if (agent.data && !isMissing(agent.error)) return <Loaded agent={agent.data} project={project} />;
  return <DetailFailed section="agents" name={name} error={agent.error} retry={() => void agent.refetch()} seenFrom={seen} />;
}
