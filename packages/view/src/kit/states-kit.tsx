// The kit's states of a list: empty, loading and refused, each as a direction.
import { RotateCcw } from "lucide-react";
import { SousError } from "../api/client.ts";
import { Button } from "../ui/button.tsx";
import { EmptyState } from "../ui/empty-state.tsx";
import { Refusal } from "../ui/refusal.tsx";
import { LoadingRows, Skel } from "../ui/skeleton.tsx";
import { KitGroup } from "./kit-section.tsx";

const UNREACHABLE = new SousError({ code: "unreachable", message: "The page can't reach sous serve.", change: "Run sous serve again, then reload the page.", call: "sous serve" }, 0);

export function StatesKit() {
  return (
    <>
      <KitGroup title="Empty" note="What is missing, and the one command or action that fills it.">
        <div className="grid gap-x-8 min-[900px]:grid-cols-2">
          <EmptyState title="No runs yet" command="sous run ticket">
            Start a workflow here or from the terminal. Its runs show in this list.
          </EmptyState>
          <EmptyState title="No workflows in billing" action={<Button size="sm">Start a workflow</Button>}>
            sous looks for workflows in .sous/workflows of this project and in ~/.sous.
          </EmptyState>
        </div>
      </KitGroup>

      <KitGroup title="Loading" note="Rows of the height the list will have, in --skel. No spinner over the page.">
        <div className="grid gap-8 min-[900px]:grid-cols-[240px_minmax(0,1fr)]">
          <div className="rounded-lg bg-side py-1">
            <LoadingRows label="Loading runs" rows={6} rowHeight={28} />
          </div>
          <div>
            <Skel className="mb-3 h-[22px] w-2/5" />
            <LoadingRows label="Loading steps" rows={4} />
          </div>
        </div>
      </KitGroup>

      <KitGroup title="Refusal" note="What happened, what to change, and the call to make instead, with a copy button.">
        <div className="flex max-w-[640px] flex-col gap-5">
          <Refusal error={UNREACHABLE} action={<Button size="sm" icon={RotateCcw}>Try again</Button>} />
          <Refusal error={{ code: "not_approved", message: "ticket.js changed since you approved it.", change: "Read the changes, then approve them to start.", call: "sous workflows approve ticket" }} />
          <Refusal error={new Error("Failed to fetch")} />
        </div>
      </KitGroup>
    </>
  );
}
