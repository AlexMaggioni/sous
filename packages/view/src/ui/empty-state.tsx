// An empty list, as a direction: what is missing, and the one command or action that fills it.
import type { ReactNode } from "react";
import { CommandBox } from "./copy.tsx";

/** `command` is the sous command that fills the list, with a copy button. `action` is a button that does the same here. */
export function EmptyState({ title, children, command, action }: { title: string; children?: ReactNode; command?: string; action?: ReactNode }) {
  return (
    <div className="max-w-[560px] py-8">
      <h2 className="mb-1.5 text-md font-medium">{title}</h2>
      {children && <div className="mb-3 text-pretty text-muted">{children}</div>}
      {(command || action) && (
        <div className="flex flex-wrap items-center gap-2">
          {action}
          {command && <CommandBox command={command} />}
        </div>
      )}
    </div>
  );
}
