import { Dialog } from "../ui/dialog.tsx";
import { Kbd } from "../ui/kbd.tsx";
import { SHORTCUTS } from "./keys.ts";

/** Every shortcut and what it does. The help dialog and the settings page show it. */
export function ShortcutList() {
  return (
    <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-6">
      {SHORTCUTS.map((s) => (
        <div key={s.keys} className="col-span-2 grid grid-cols-subgrid items-center border-b border-line py-1.5 last:border-b-0">
          <dt className="min-w-0">{s.does}</dt>
          <dd className="flex justify-end">
            <Kbd keys={s.keys} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** `?` opens it. None of the keys fire while the person types in a field. */
export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Keyboard shortcuts" description="Letter keys wait while you type in a field.">
      <ShortcutList />
    </Dialog>
  );
}
