// An MCP server: how sous reaches it, each env value or header as the server sends it, masked, with
// where sous reads it, then what uses it. The entry as the file writes it folds behind "Show in file".
import { Link, useParams, useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { McpPage, McpValue } from "../../api/contract.ts";
import { useMcp } from "../../api/queries.ts";
import { usePageProject, useProjectName, useProjectSearch } from "../../api/seen-from.ts";
import { HARNESS_NAME } from "../../lists/catalog-rows.ts";
import { CodeFrame, CodeLines } from "../../ui/code-block.tsx";
import { fileName, Path, type Fact } from "../../ui/facts.tsx";
import { Fold } from "../../ui/fold.tsx";
import { DetailFailed, DetailLoading, DetailPage, isMissing, LINK, None, Section, Stack } from "../detail/detail-page.tsx";
import { placeOf } from "../detail/detail-words.ts";

const TYPE_WORDS = { stdio: "stdio, sous starts it", http: "http, sous connects to it", sse: "sse, sous connects to it" } as const;

/**
 * Where sous reads a value, under the value itself, and whether the page masks it. A ${NAME} shows
 * as written. sous masks every literal, also one that doesn't look like a secret, so the line says
 * why the dots are there.
 */
function valueSource(value: McpValue): string {
  const masked = value.value.includes("••••") || (value.secret && !/\$\{\w+\}/.test(value.value));
  if (value.from) return masked ? `Masked, read from ${value.from}` : `Read from ${value.from}`;
  if (!masked) return "Written in the file";
  return value.secret ? "A secret, masked here" : "Written in the file, masked here";
}

function Rows({ rows }: { rows: Array<{ key: string; label: ReactNode; value: ReactNode }> }) {
  return (
    <dl className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-6 gap-y-2 max-[699px]:grid-cols-1 max-[699px]:gap-y-1">
      {rows.map((row) => (
        <div key={row.key} className="contents">
          <dt className="text-muted max-[699px]:mt-2">{row.label}</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A value exactly as the server sends it, masked or not, with where sous reads it. */
function Value({ value }: { value: McpValue }) {
  return (
    <>
      <code>{value.value}</code>
      <span className="block text-xs text-muted">{valueSource(value)}</span>
    </>
  );
}

function Connection({ mcp }: { mcp: McpPage }) {
  const values = [...mcp.env.map((v) => ({ ...v, kind: "env" })), ...mcp.headers.map((v) => ({ ...v, kind: "header" }))];
  const filled = values.some((v) => v.from || /\$\{\w+\}/.test(v.value));
  const rows = [
    { key: "type", label: "Type", value: TYPE_WORDS[mcp.type] },
    mcp.type === "stdio"
      ? { key: "command", label: "Command", value: mcp.command ? <code>{[mcp.command, ...(mcp.args ?? [])].join(" ")}</code> : <None /> }
      : { key: "url", label: "URL", value: mcp.url ? <code>{mcp.url}</code> : <None /> },
    ...values.map((v) => ({ key: `${v.kind}:${v.key}`, label: <code className="text-fg">{v.key}</code>, value: <Value value={v} /> })),
  ];
  return (
    <>
      <Rows rows={rows} />
      {filled && <p className="mt-3 max-w-[40em] text-pretty text-muted">sous fills each {"${NAME}"} when a step starts. Neither this page nor the agent sees the value.</p>}
    </>
  );
}

function UsedBy({ mcp, project }: { mcp: McpPage; project?: string }) {
  const search = useProjectSearch(project);
  const agents = mcp.usedBy.filter((u) => u.kind === "agent");
  const steps = mcp.usedBy.filter((u) => u.kind === "step");
  return (
    <Rows
      rows={[
        {
          key: "agents",
          label: "Agents",
          value: agents.length ? (
            <Stack>
              {agents.map((a) => (
                <Link key={a.name} to="/agents/$name" params={{ name: a.name }} search={search} className={LINK}>
                  {a.name}
                </Link>
              ))}
            </Stack>
          ) : (
            <None>No agent lists it</None>
          ),
        },
        {
          key: "steps",
          label: "Steps",
          value: steps.length ? (
            <Stack>
              {steps.map((s) => (
                <span key={`${s.workflow}:${s.name}`}>
                  <span className="font-mono text-xs">{s.name}</span>
                  {s.workflow && (
                    <>
                      <span className="text-muted"> in </span>
                      <Link to="/workflows/$name" params={{ name: s.workflow }} search={search} className={LINK}>
                        {s.workflow}
                      </Link>
                    </>
                  )}
                </span>
              ))}
            </Stack>
          ) : (
            <None>No step adds it</None>
          ),
        },
      ]}
    />
  );
}

function mcpFacts(mcp: McpPage): Fact[] {
  const secrets = [...mcp.env, ...mcp.headers].filter((v) => v.secret).length;
  return [
    { label: "Seen by", value: mcp.seenBy.length ? mcp.seenBy.map((h) => HARNESS_NAME[h]).join(" and ") : <None>No harness</None> },
    // The source is often the file itself, such as .mcp.json, so it shows only when it says more.
    ...(mcp.files[0] && fileName(mcp.files[0].file) === fileName(mcp.source) ? [] : [{ label: "Source", value: <code>{mcp.source}</code> }]),
    { label: "Secrets", value: secrets ? <span className="tabular-nums">{secrets}</span> : <None />, sub: secrets ? "Masked on this page" : undefined },
    {
      label: mcp.files.length > 1 ? "Files" : "File",
      value: mcp.files.length ? (
        <Stack>
          {mcp.files.map((f, i) => (
            <span key={f.file}>
              <Path path={f.file} />
              <span className="block text-xs text-muted">
                {placeOf(f.scope, f.harness)}
                {mcp.files.length > 1 && i > 0 ? ", not used" : ""}
              </span>
            </span>
          ))}
        </Stack>
      ) : (
        <None />
      ),
    },
  ];
}

function Loaded({ mcp, project }: { mcp: McpPage; project?: string }) {
  const file = mcp.files[0]?.file;
  const name = file ? fileName(file) : mcp.source;
  return (
    <DetailPage section="mcp" name={mcp.name} facts={mcpFacts(mcp)}>
      <Section title="Connection">
        <Connection mcp={mcp} />
      </Section>
      <Section title="Used by">
        <UsedBy mcp={mcp} project={project} />
      </Section>
      <Fold title="Show in file">
        <CodeFrame path={name} meta="Secrets masked" copy={mcp.raw}>
          <CodeLines code={mcp.raw} lang="json" label={`Entry of ${mcp.name} in ${name}`} />
        </CodeFrame>
      </Fold>
    </DetailPage>
  );
}

/** One MCP server, at #/mcp/$name, as sous finds it from the project its link names, else the one the lists are seen from. */
export function McpDetail() {
  const { name } = useParams({ from: "/mcp/$name" });
  const project = usePageProject(useSearch({ from: "/mcp/$name" }).project);
  const seen = useProjectName(project);
  const mcp = useMcp(name, project);
  if (mcp.isPending) return <DetailLoading section="mcp" name={name} />;
  if (mcp.data && !isMissing(mcp.error)) return <Loaded mcp={mcp.data} project={project} />;
  return <DetailFailed section="mcp" name={name} error={mcp.error} retry={() => void mcp.refetch()} seenFrom={seen} />;
}
