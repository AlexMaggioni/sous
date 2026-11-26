// The header's actions on a workflow page: Start, the one primary, and the "More" menu, which
// moves the file to the trash after a question that names its path.
import { useNavigate } from "@tanstack/react-router";
import { Play, Trash2 } from "lucide-react";
import type { WorkflowPage } from "../../api/contract.ts";
import { useTrashWorkflow } from "../../api/queries.ts";
import { openStart } from "../../start/start-store.ts";
import { Button } from "../../ui/button.tsx";
import { confirm } from "../../ui/confirm.tsx";
import { fileName } from "../../ui/facts.tsx";
import { Menu, MenuItem } from "../../ui/menu.tsx";
import { toast } from "../../ui/toast.tsx";

/** Asks once before the file moves. `move` runs while the question stays open, so a refusal shows in it. */
function askTrash(file: string, move: () => Promise<unknown>): Promise<boolean> {
  return confirm({
    title: `Move ${fileName(file)} to the trash?`,
    body: "The file moves to the trash folder of the sous home, so nothing can start it. Its runs stay, and you can move it back from there.",
    path: file,
    confirmLabel: "Move to trash",
    danger: true,
    run: move,
  });
}

/** Why Start is off, or false when it can run. */
export const startBlocked = (workflow: WorkflowPage): string | false => (workflow.problems.length ? "Start stays off until sous check passes" : false);

export function WorkflowActions({ workflow, project }: { workflow: WorkflowPage; project?: string }) {
  const navigate = useNavigate();
  const trash = useTrashWorkflow(project);
  const moveToTrash = async () => {
    const moved = await askTrash(workflow.file, () => trash.mutateAsync(workflow.name));
    if (!moved) return;
    void navigate({ to: "/workflows" });
    toast(`Moved ${fileName(workflow.file)} to the trash`);
  };
  return (
    <>
      <Button variant="primary" icon={Play} disabled={startBlocked(workflow)} onClick={() => openStart(workflow.name)}>
        Start
      </Button>
      <Menu label="More">
        <MenuItem icon={Trash2} danger onSelect={() => void moveToTrash()}>
          Move to trash
        </MenuItem>
      </Menu>
    </>
  );
}
