// The kit's buttons, menus, tooltips and keys, in each state.
import { Copy, PanelLeft, Play, RotateCcw, Square, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button, IconButton } from "../ui/button.tsx";
import { Kbd } from "../ui/kbd.tsx";
import { Menu, MenuChoice, MenuItem, MenuSeparator } from "../ui/menu.tsx";
import { toast } from "../ui/toast.tsx";
import { Tip } from "../ui/tooltip.tsx";
import { KitGroup } from "./kit-section.tsx";

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

const GROUPS = [
  { value: "project", label: "Project" },
  { value: "status", label: "Status" },
  { value: "none", label: "None" },
] as const;

export function ButtonsKit() {
  const [group, setGroup] = useState<(typeof GROUPS)[number]["value"]>("project");
  return (
    <>
      <KitGroup title="Buttons" note="Primary is ink, one per page. Secondary has a gray fill, quiet has none until hover. A press that returns a Promise shows the spinner until it settles. A disabled button stays focusable and its tooltip says why.">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={Play} onClick={() => wait(1200)}>
              Start
            </Button>
            <Button onClick={() => wait(1200)}>Approve</Button>
            <Button variant="quiet">Send back</Button>
            <Button variant="danger" icon={Trash2}>
              Remove
            </Button>
            <Button busy>Resume</Button>
            <Button disabled="The run already ended." icon={Square}>
              Stop
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="primary">
              Answer
            </Button>
            <Button size="sm" icon={RotateCcw} onClick={() => wait(1200)}>
              Rerun
            </Button>
            <Button size="sm" variant="quiet">
              Tell
            </Button>
            <Button size="sm" variant="danger">
              Remove
            </Button>
            <Button size="sm" variant="primary" busy>
              Answer
            </Button>
            <Button size="sm" disabled="Answer the question first.">
              Resume
            </Button>
          </div>
          <div data-surface="side" className="flex flex-wrap items-center gap-2 rounded-lg bg-side p-2">
            <Button size="sm">Start a workflow</Button>
            <Button size="sm" variant="danger">
              Remove
            </Button>
            <span className="text-xs text-muted">In the sidebar, secondary sits on --bg-raised.</span>
          </div>
        </div>
      </KitGroup>

      <KitGroup title="Icon buttons" note="A gray icon in a 28px square, or 24px in dense rows. The tooltip names the action and its keys.">
        <div className="flex flex-wrap items-center gap-2">
          <IconButton icon={PanelLeft} label="Hide sidebar" shortcut="mod+b" />
          <IconButton icon={Copy} label="Copy the run id" onClick={() => toast("Copied", { command: "r-2c8f1d" })} />
          <IconButton icon={RotateCcw} label="Rerun" onClick={() => wait(1200)} />
          <IconButton icon={Trash2} label="Remove" busy />
          <IconButton icon={Square} label="Stop" disabled="The run already ended." />
          <IconButton icon={Copy} label="Copy" size="sm" />
        </div>
      </KitGroup>

      <KitGroup title="Menu" note="Opens under its button. Arrow keys move, Escape closes and returns focus. A disabled item says why.">
        <div className="flex flex-wrap items-center gap-2">
          <Menu label="More">
            <MenuItem icon={RotateCcw} onSelect={() => toast("Rerun r-2c8f1d started", { command: "sous rerun r-2c8f1d" })}>
              Rerun
            </MenuItem>
            <MenuItem icon={Copy} shortcut="mod+shift+c" onSelect={() => toast("Copied", { command: "r-2c8f1d" })}>
              Copy the run id
            </MenuItem>
            <MenuItem icon={Square} disabled="The run already ended.">
              Stop
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={Trash2} danger onSelect={() => toast("Removed r-2c8f1d", { undo: () => toast("Restored r-2c8f1d") })}>
              Remove
            </MenuItem>
          </Menu>
          <Menu label="Group and filter" size="sm" align="start">
            <MenuChoice label="Group by" value={group} onChange={setGroup} options={GROUPS} />
          </Menu>
          <span className="text-xs text-muted">Grouped by {group}</span>
        </div>
      </KitGroup>

      <KitGroup title="Tooltip and keys">
        <div className="flex flex-wrap items-center gap-4">
          <Tip text="/Users/maya/code/billing/.sous/workflows/ticket.js">
            <button type="button" className="rounded-sm font-mono text-xs">
              ticket.js
            </button>
          </Tip>
          <span className="inline-flex items-center gap-1.5 text-muted">
            <Kbd keys="mod+k" /> search
          </span>
          <span className="inline-flex items-center gap-1.5 text-muted">
            <Kbd keys="/" /> search
          </span>
          <span className="inline-flex items-center gap-1.5 text-muted">
            <Kbd keys="g r" /> go to runs
          </span>
          <span className="inline-flex items-center gap-1.5 text-muted">
            <Kbd keys="Escape" /> close
          </span>
        </div>
      </KitGroup>
    </>
  );
}
