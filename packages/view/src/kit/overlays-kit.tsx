// The kit's dialogs, confirm questions, toasts and search palette, each opened by a button.
import { Bot, BookOpen, Play, Search, Workflow } from "lucide-react";
import { useState, type FormEvent } from "react";
import { SousError } from "../api/client.ts";
import { Button } from "../ui/button.tsx";
import { CommandMenu, type CommandSection } from "../ui/command-menu.tsx";
import { confirm } from "../ui/confirm.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { InputField } from "../ui/field.tsx";
import { Kbd } from "../ui/kbd.tsx";
import { toast } from "../ui/toast.tsx";
import { INPUTS, WORKFLOW_PATH } from "./kit-data.ts";
import { KitGroup } from "./kit-section.tsx";

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

const SEARCH: CommandSection[] = [
  {
    label: "Runs",
    items: [
      { value: "run:r-2c8f1d", label: "Round invoice totals once", meta: "ticket", icon: Play, keywords: ["r-2c8f1d"] },
      { value: "run:r-8d2v7f", label: "Nightly triage", meta: "factory", icon: Play, keywords: ["r-8d2v7f"] },
    ],
  },
  {
    label: "Workflows",
    items: [
      { value: "workflow:ticket", label: "ticket", meta: "Implement a ticket, then review it", icon: Workflow },
      { value: "workflow:factory", label: "factory", meta: "Triage the team's new tickets", icon: Workflow },
    ],
  },
  { label: "Agents", items: [{ value: "agent:reviewer", label: "reviewer", meta: "Claude Code", icon: Bot }] },
  { label: "Skills", items: [{ value: "skill:code-review", label: "code-review", meta: "How to review a diff", icon: BookOpen }] },
];

function StartDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const ticket = String(new FormData(event.currentTarget).get("ticket") ?? "").trim();
    if (!ticket) return setTried(true);
    setBusy(true);
    await wait(900);
    setBusy(false);
    onOpenChange(false);
    toast("Started ticket", { command: `sous run ticket --ticket "${ticket}"` });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Start ticket"
      description="The run works in a new worktree of billing."
      actions={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="kit-start" busy={busy}>
            Start
          </Button>
        </>
      }
    >
      <form id="kit-start" noValidate onSubmit={submit} className="flex flex-col gap-4">
        {INPUTS.map((input) => (
          <InputField key={input.name} input={input} error={tried && input.name === "ticket" ? "Fill in ticket. sous run refuses to start without it." : undefined} />
        ))}
      </form>
    </Dialog>
  );
}

// The buttons that open a question don't return its Promise, so they don't spin behind the dialog.
async function removeFile() {
  const removed = await confirm({
    title: "Remove ticket.js?",
    body: "sous deletes the workflow file. Its past runs stay in the list.",
    path: WORKFLOW_PATH,
    confirmLabel: "Remove",
    danger: true,
    run: () => wait(900),
  });
  if (removed) toast("Removed ticket.js");
}

async function stopRefused() {
  await confirm({
    title: "Stop r-2c8f1d?",
    body: "The step that runs now ends, and the run stops. You can resume it later.",
    confirmLabel: "Stop the run",
    run: async () => {
      await wait(700);
      throw new SousError({ code: "run_ended", message: "The run already ended.", change: "Rerun it to start again.", call: "sous rerun r-2c8f1d" }, 409);
    },
  });
}

export function OverlaysKit() {
  const [start, setStart] = useState(false);
  const [search, setSearch] = useState(false);
  return (
    <>
      <KitGroup title="Dialog" note="The title, a body that scrolls, and the actions at the bottom right. Escape and the scrim close it, and focus goes back to the button.">
        <Button variant="primary" icon={Play} onClick={() => setStart(true)}>
          Start ticket
        </Button>
        <StartDialog open={start} onOpenChange={setStart} />
      </KitGroup>

      <KitGroup title="Confirm" note="Names the thing and the path it removes. Focus starts on Cancel. The button stays busy while the work runs, and a refusal shows in the dialog.">
        <div className="flex flex-wrap gap-2">
          <Button variant="danger" onClick={() => void removeFile()}>
            Remove ticket.js
          </Button>
          <Button onClick={() => void stopRefused()}>Stop with a refusal</Button>
        </div>
      </KitGroup>

      <KitGroup title="Toasts" note="The button's own verb, the sous command that does the same, and Undo for 8 seconds after a removal. Hover or focus holds a toast.">
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => toast("Stopped r-2c8f1d", { command: "sous stop r-2c8f1d" })}>Stop</Button>
          <Button onClick={() => toast("Answer sent")}>Answer</Button>
          <Button variant="danger" onClick={() => toast("Removed r-2c8f1d", { undo: () => toast("Restored r-2c8f1d") })}>
            Remove a run
          </Button>
        </div>
      </KitGroup>

      <KitGroup title="Search" note="Arrow keys move, Enter opens, Escape closes. No match says what was searched and where it looked.">
        <Button icon={Search} onClick={() => setSearch(true)}>
          <span className="inline-flex items-center gap-2">
            Search <Kbd keys="/" />
          </span>
        </Button>
        <CommandMenu
          open={search}
          onOpenChange={setSearch}
          label="Search runs, workflows, agents and skills"
          placeholder="Search runs, workflows, agents, skills and MCP"
          groups={SEARCH}
          onRun={(value) => toast(`Opened ${value.split(":")[1]}`)}
          empty={(query) => (
            <>
              No run, workflow, agent, skill or MCP server matches <b className="font-medium text-fg">{query}</b>. sous looked in billing and in ~/.sous.
            </>
          )}
        />
      </KitGroup>
    </>
  );
}
