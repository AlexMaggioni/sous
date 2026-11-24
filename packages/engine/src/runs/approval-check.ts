// The check of a start: a workflow an agent, a step of a run or a schedule starts needs the
// person's yes to its exact text, and each saved workflow it starts by name needs one too. The
// yes itself, and the seed of the first use, are in approvals.ts.

import { projectWorkflows, resolveWorkflow, type ResolvedWorkflow, type WorkflowDir, type WorkflowDirEntry } from "../workflows/dir.js";
import { readWorkflowScript } from "../workflows/script.js";
import { noticeOf, recordAction, type Who } from "./actions.js";
import { approveWorkflow, isApproved, seedApprovals, workflowHash } from "./approvals.js";
import { nestedLookup } from "./consent.js";
import { loadConfig, type HomePaths } from "./home.js";
import { notify } from "./notify.js";
import type { RunRecord } from "./records.js";
import { Refusal } from "./refusal.js";

/**
 * A workflow with no yes for its text. `workflow` is what the person gives `sous workflows
 * approve`: the workflow's name, or its file when that name finds another file.
 */
export class NotApproved extends Refusal {
  constructor(readonly workflow: string, message: string) {
    const change =
      `Show the person the change the call gives and ask them. Once they agree, run sous workflows approve ${workflow} --by person, ` +
      `or they type sous workflows approve ${workflow} in their own terminal.`;
    super("not_approved", message, change, `sous workflows show ${workflow} --diff --json`);
  }
}

const unapproved = (name: string, root?: string) =>
  `${root ? `${root} starts ${name}, and ` : ""}${name} is new or changed since the person approved it. ` +
  "An agent, a step of a run or a schedule starts a workflow only once the person approved its text.";

/** Each saved workflow a script names in workflow("name"), and the ones those name, with its text. */
function namedWorkflows(view: WorkflowDir, entries: WorkflowDirEntry[], names: string[]): Array<{ name: string; file: string; text: string }> {
  const found = new Map<string, { name: string; file: string; text: string }>();
  const next = [...names];
  for (let name = next.shift(); name !== undefined; name = next.shift()) {
    const entry = entries.find((candidate) => candidate.name === name);
    const text = entry && !found.has(name) ? view.resolve(name) : undefined;
    if (!entry || text === undefined) continue;
    found.set(name, { name, file: entry.file, text });
    try {
      next.push(...readWorkflowScript(text).refs.workflows);
    } catch {
      // A file that does not parse fails when the run reaches it.
    }
  }
  return [...found.values()];
}

/**
 * A start needs the person's yes to the workflow's text and to each saved workflow it names in
 * workflow("name"). A start from the person's own terminal is that yes: it approves them with no
 * line of its own. Any other start of a text with no yes is refused with not_approved.
 */
export function needApproval(paths: HomePaths, projectDir: string, resolved: Pick<ResolvedWorkflow, "name" | "file" | "script" | "refs">, who: Who): void {
  // The first use seeds the workflows sous knows as they are, before this start's own yes.
  seedApprovals(paths);
  const view = projectWorkflows(paths, projectDir);
  const entries = view.list();
  const root = entries.find((entry) => entry.name === resolved.name)?.file === resolved.file ? resolved.name : resolved.file;
  for (const { name, file, text } of [{ name: root, file: resolved.file, text: resolved.script }, ...namedWorkflows(view, entries, resolved.refs.workflows)]) {
    if (who.through.kind === "person") approveWorkflow(paths, file, text, who);
    else if (!isApproved(paths, file, text)) throw new NotApproved(name, unapproved(name, name === root ? undefined : root));
  }
}

/** A workflow `sous workflows approve` looked at: its name, its file, and the hash of its text. */
export interface ApprovedText {
  workflow: string;
  file: string;
  hash: string;
}

/**
 * The person's yes to a workflow's text as it is now, by name or path, or to each workflow the
 * project sees with `target` undefined (--all). Only the person approves: an agent passes the
 * person's word on with --by person, and without it the call is refused with needs_person. Each
 * new yes adds one approve-workflow line, and one made through an agent tells the person. A text
 * approved already is left as it is.
 */
export function approveWorkflows(paths: HomePaths, projectDir: string, target: string | undefined, who: Who): { approved: ApprovedText[]; unchanged: ApprovedText[] } {
  const view = projectWorkflows(paths, projectDir);
  const texts = target === undefined
    ? view.list().flatMap((entry) => {
        const text = view.resolve(entry.name);
        return text === undefined ? [] : [{ workflow: entry.name, file: entry.file, text }];
      })
    : [resolveWorkflow(paths, projectDir, target)].map((resolved) => ({ workflow: resolved.name, file: resolved.file, text: resolved.script }));
  if (who.by !== "person") {
    const what = target ?? "--all";
    const message = `Only the person approves a workflow. sous does not approve ${target ?? "the changed workflows"} on an agent's word alone.`;
    const change = `Show the person each change with sous workflows show ${target ?? "<name>"} --diff and ask them. Once they agree, make the call. Or they type sous workflows approve ${what} in their own terminal.`;
    throw new Refusal("needs_person", message, change, `sous workflows approve ${what} --by person --json`);
  }
  const approved: ApprovedText[] = [];
  const unchanged: ApprovedText[] = [];
  for (const { workflow, file, text } of texts) {
    if (isApproved(paths, file, text)) {
      unchanged.push({ workflow, file, hash: workflowHash(text) });
      continue;
    }
    const { hash } = approveWorkflow(paths, file, text, who);
    approved.push({ workflow, file, hash });
    const notice = noticeOf(recordAction(paths, { act: "approve-workflow", ...who, workflow, hash }));
    if (notice) notify(notice.title, notice.message, loadConfig(paths).notify);
  }
  return { approved, unchanged };
}

/**
 * The nested workflows of a run, guarded. A run an agent or a step of a run started may not reach
 * a people workflow through workflow() or choose(), as nestedLookup says. A run an agent, a step
 * of a run or a schedule started reaches a workflow only with the person's yes to its text, and
 * choose() offers only those. A run a person started, a dry run, and an older record with no
 * through reach every workflow.
 */
export function approvedLookup(
  paths: HomePaths,
  record: Pick<RunRecord, "through" | "origin" | "projectDir">,
  lookup: (name: string) => string | undefined,
): { lookup: (name: string) => string | undefined; offers: (entry: WorkflowDirEntry) => boolean } {
  const { through } = record;
  const guarded = nestedLookup(through, lookup);
  const needsYes = through !== undefined && through.kind !== "person" && record.origin !== "check";
  const approved = (file: string | undefined, script: string) => file !== undefined && isApproved(paths, file, script);
  const fileOf = (name: string) => projectWorkflows(paths, record.projectDir).list().find((entry) => entry.name === name)?.file;
  return {
    lookup: (name) => {
      const script = guarded(name);
      if (script !== undefined && needsYes && !approved(fileOf(name), script)) throw new NotApproved(name, unapproved(name));
      return script;
    },
    offers: (entry) => {
      if (!needsYes) return true;
      const script = lookup(entry.name);
      return script !== undefined && approved(entry.file, script);
    },
  };
}
