// The search palette: one field over runs, workflows, agents, skills and MCP servers, grouped by kind.
import { Command, CommandEmpty, CommandGroup, CommandGroupLabel, CommandInput, CommandItem, CommandItemIcon, CommandItemText, CommandList } from "@ui-sdk/react/command";
import { DialogBackdrop, DialogContent, DialogTitle, Dialog as SdkDialog } from "@ui-sdk/react/dialog";
import { Search, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { SCRIM } from "./dialog.tsx";
import { POPUP } from "./motion.ts";
import { Kbd } from "./kbd.tsx";

export type CommandEntry = {
  /** What `onRun` gets, such as a route. Unique across groups. */
  value: string;
  label: string;
  icon?: LucideIcon;
  /** A muted word after the label, such as the workflow of a run. */
  meta?: string;
  /** More words the search matches, such as a run's id. */
  keywords?: readonly string[];
};

export type CommandSection = { label: string; items: readonly CommandEntry[] };

/**
 * Arrow keys move, Enter runs, Escape closes and returns focus. The search matches letters in
 * order and marks them. `empty` says what was searched and where it looked, from the query.
 */
export function CommandMenu({ open, onOpenChange, label, placeholder, groups, onRun, empty }: { open: boolean; onOpenChange: (open: boolean) => void; label: string; placeholder: string; groups: readonly CommandSection[]; onRun: (value: string) => void; empty: (query: string) => ReactNode }) {
  const [query, setQuery] = useState("");
  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) setQuery("");
  };
  return (
    <SdkDialog open={open} onOpenChange={(next) => close(next)}>
      <DialogBackdrop className={SCRIM} />
      <DialogContent className={`fixed inset-x-0 top-[10vh] z-50 mx-auto flex max-h-[80dvh] w-[min(600px,calc(100%-32px))] flex-col overflow-hidden rounded-lg border border-line bg-raised p-0 text-fg outline-none ${POPUP} data-ending-style:opacity-0 data-starting-style:translate-y-1 data-starting-style:opacity-0`}>
        <DialogTitle className="sr-only">{label}</DialogTitle>
        <Command
          query={query}
          onQueryChange={(next) => setQuery(next)}
          onAction={(value) => {
            close(false);
            onRun(value);
          }}
          loop
          className="flex min-h-0 flex-col"
        >
          <div className="flex h-11 flex-none items-center gap-2 border-b border-line px-4 max-[699px]:h-12">
            <Search size={16} strokeWidth={1.5} aria-hidden="true" className="flex-none text-icon" />
            <CommandInput aria-label={label} placeholder={placeholder} className="h-10 min-w-0 flex-1 bg-transparent text-md outline-none placeholder:text-muted" />
          </div>
          <CommandList className="min-h-0 overflow-y-auto px-2 pt-1 pb-2 empty:hidden">
            {groups
              .filter((group) => group.items.length > 0)
              .map((group) => (
                <CommandGroup key={group.label}>
                  <CommandGroupLabel className="px-2 pt-3 pb-1 text-xs font-medium text-muted">{group.label}</CommandGroupLabel>
                  {group.items.map((item) => (
                    <CommandItem
                      key={item.value}
                      value={item.value}
                      label={item.label}
                      keywords={item.keywords ? [...item.keywords] : undefined}
                      className="flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 py-1 data-highlighted:bg-selected max-[699px]:min-h-10"
                    >
                      {item.icon && (
                        <CommandItemIcon className="flex-none text-icon">
                          <item.icon size={16} strokeWidth={1.5} aria-hidden="true" />
                        </CommandItemIcon>
                      )}
                      <CommandItemText className="max-w-[60%] flex-none truncate">{item.label}</CommandItemText>
                      {item.meta && <span className="min-w-0 flex-1 truncate text-xs text-muted">{item.meta}</span>}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
          </CommandList>
          <CommandEmpty className="max-w-[34em] px-4 py-3 text-muted">{empty(query)}</CommandEmpty>
          <div className="flex flex-none flex-wrap gap-4 border-t border-line px-4 py-2 text-xs text-muted max-[699px]:hidden">
            <span className="inline-flex items-center gap-1.5">
              <Kbd keys="ArrowUp ArrowDown" /> move
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Kbd keys="Enter" /> open
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Kbd keys="Escape" /> close
            </span>
          </div>
        </Command>
      </DialogContent>
    </SdkDialog>
  );
}
