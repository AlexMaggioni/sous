// Start a workflow, from anywhere: with no workflow named, a search over the saved ones first; then
// the form of the one picked. The shell draws this once, and openStart() opens it.
import { useRef } from "react";
import { useWorkflows } from "../api/queries.ts";
import { useProjectName, useSeenFrom } from "../api/seen-from.ts";
import { groupWorkflows } from "../lists/catalog-rows.ts";
import { CommandMenu, type CommandSection } from "../ui/command-menu.tsx";
import { StartForm } from "./start-form.tsx";
import { closeStart, openStart, useStartState } from "./start-store.ts";

/** The saved workflows to pick from, the project's first. A home workflow the project's hides is left out. */
function WorkflowPicker({ open }: { open: boolean }) {
  const project = useSeenFrom();
  const projectName = useProjectName(project);
  const rows = useWorkflows(project);
  const groups: CommandSection[] = groupWorkflows(rows.data ?? [], projectName ?? "This project", "").map((group) => ({
    label: group.label,
    items: group.items
      .filter((row) => row.from === "project" || !rows.data?.some((other) => other.from === "project" && other.name === row.name))
      .map((row) => ({ value: row.name, label: row.name, meta: row.description, keywords: row.description ? [row.description] : undefined })),
  }));
  return (
    <CommandMenu
      open={open}
      onOpenChange={(next) => !next && closeStart()}
      label="Start a workflow"
      placeholder="Start a workflow"
      groups={groups}
      onRun={(name) => openStart(name)}
      empty={(query) =>
        rows.isPending
          ? "Reading the workflows."
          : rows.error
            ? "The workflows did not load. Close this and try again."
            : !rows.data?.length
              ? "No saved workflows yet. A workflow is one JS file in .sous/workflows. sous guide writes a first one with you."
              : `Nothing matches "${query}". The search looks at the names and descriptions of the workflows${projectName ? ` seen from ${projectName}` : ""}.`
      }
    />
  );
}

export function StartDialog() {
  const start = useStartState();
  // The form keeps its workflow while it closes, and starts fresh each time it opens.
  const last = useRef<string | undefined>(undefined);
  const session = useRef(0);
  const wasOpen = useRef(false);
  if (start.open && !wasOpen.current) session.current += 1;
  wasOpen.current = start.open;
  if (start.open && start.workflow) last.current = start.workflow;
  // The picker reads the workflows only once someone asks for it.
  const asked = useRef(false);
  if (start.open && !start.workflow) asked.current = true;
  const name = start.open ? start.workflow : last.current;
  return (
    <>
      {asked.current && <WorkflowPicker open={start.open && !start.workflow} />}
      {name && <StartForm key={`${session.current}:${name}`} name={name} open={start.open && start.workflow === name} />}
    </>
  );
}
