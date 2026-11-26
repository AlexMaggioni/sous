// A skill: its SKILL.md on the left, rendered or raw, and on the right every place a harness finds
// it, the harness that misses it, and what uses it.
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { Check } from "lucide-react";
import type { SkillPage } from "../../api/contract.ts";
import { useSkill } from "../../api/queries.ts";
import { usePageProject, useProjectName, useProjectSearch } from "../../api/seen-from.ts";
import { HARNESS_NAME } from "../../lists/catalog-rows.ts";
import type { ProjectSearch } from "../../router.tsx";
import { Path, type Fact } from "../../ui/facts.tsx";
import { Tip } from "../../ui/tooltip.tsx";
import { DetailFailed, DetailLoading, DetailPage, isMissing, LINK, None, Stack } from "../detail/detail-page.tsx";
import { placeOf } from "../detail/detail-words.ts";
import { SourceBlock } from "../detail/source-block.tsx";

/** One short row per place: its name, then a check, and a row with "missing" for each harness without it. */
function Copies({ skill }: { skill: SkillPage }) {
  return (
    <span className="flex flex-col gap-0.5">
      {skill.copies.map((copy) => (
        <span key={copy.file} className="flex items-center gap-2">
          <Tip text={copy.file}>
            <button type="button" className="min-w-0 cursor-default truncate rounded-sm text-left">
              {placeOf(copy.scope, copy.harness)}
            </button>
          </Tip>
          <Check size={14} strokeWidth={1.5} role="img" aria-label="has a copy" className="flex-none text-icon" />
        </span>
      ))}
      {skill.missing.map((harness) => (
        <span key={harness} className="flex items-center gap-2">
          <span>{HARNESS_NAME[harness]}</span>
          <span className="text-xs text-muted">missing</span>
        </span>
      ))}
    </span>
  );
}

/** `search` keeps the page's project on its links. */
function skillFacts(skill: SkillPage, search: ProjectSearch): Fact[] {
  return [
    { label: "Copies", value: <Copies skill={skill} /> },
    {
      label: "Used by",
      value: skill.usedBy.length ? (
        <Stack>
          {skill.usedBy.map((use) =>
            use.kind === "agent" ? (
              <Link key={`agent:${use.name}`} to="/agents/$name" params={{ name: use.name }} search={search} className={LINK}>
                {use.name}
              </Link>
            ) : (
              <span key={`step:${use.workflow}:${use.name}`}>
                <span className="font-mono text-xs">{use.name}</span>
                {use.workflow && (
                  <>
                    <span className="text-muted"> in </span>
                    <Link to="/workflows/$name" params={{ name: use.workflow }} search={search} className={LINK}>
                      {use.workflow}
                    </Link>
                  </>
                )}
              </span>
            ),
          )}
        </Stack>
      ) : (
        <None>No agent or step</None>
      ),
    },
    { label: "File", value: <Path path={skill.file} /> },
  ];
}

/** One skill, at #/skills/$name, as sous finds it from the project its link names, else the one the lists are seen from. */
export function SkillDetail() {
  const { name } = useParams({ from: "/skills/$name" });
  const project = usePageProject(useSearch({ from: "/skills/$name" }).project);
  const search = useProjectSearch(project);
  const seen = useProjectName(project);
  const skill = useSkill(name, project);
  if (skill.isPending) return <DetailLoading section="skills" name={name} />;
  const s = skill.data;
  if (s && !isMissing(skill.error))
    return (
      <DetailPage section="skills" name={s.name} description={s.description} facts={skillFacts(s, search)}>
        <SourceBlock file={s.file} rendered={s.body} raw={s.raw} />
      </DetailPage>
    );
  return <DetailFailed section="skills" name={name} error={skill.error} retry={() => void skill.refetch()} seenFrom={seen} />;
}
