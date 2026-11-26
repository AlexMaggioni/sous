// Menus: the "More" menu of a run, a step or a workflow, and the icon menus of the list column.
import {
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItemIcon,
  MenuItemIndicator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuShortcut,
  Menu as SdkMenu,
  MenuItem as SdkMenuItem,
  MenuSeparator as SdkMenuSeparator,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import { Tooltip, TooltipTrigger } from "@ui-sdk/react/tooltip";
import { Check, Ellipsis, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { iconButtonClass, type ButtonSize } from "./button.tsx";
import { POPUP } from "./motion.ts";
import { TipContent } from "./tooltip.tsx";

const ROW =
  "flex min-h-7 w-full cursor-default items-center gap-2 rounded-md px-2 py-1 text-left outline-none select-none data-highlighted:bg-hover data-disabled:cursor-not-allowed max-[699px]:min-h-10";

/**
 * An icon button that opens a menu under it. `label` names the button and its tooltip, such as
 * "More" or "Group and filter". Escape and an outside press close it, and focus goes back to the button.
 */
export function Menu({ label, icon: Icon = Ellipsis, size = "md", align = "end", children }: { label: string; icon?: LucideIcon; size?: ButtonSize; align?: "start" | "end"; children: ReactNode }) {
  return (
    <SdkMenu>
      <Tooltip type="label">
        <TooltipTrigger render={<MenuTrigger className={iconButtonClass(size)} />}>
          <Icon size={size === "sm" ? 14 : 16} strokeWidth={1.5} aria-hidden="true" />
        </TooltipTrigger>
        <TipContent>{label}</TipContent>
      </Tooltip>
      <MenuContent
        side="bottom"
        align={align}
        sideOffset={4}
        collisionPadding={8}
        className={`z-40 m-0 max-h-(--available-height) min-w-52 overflow-y-auto rounded-lg border border-line bg-raised p-1 text-fg ${POPUP} data-ending-style:opacity-0 data-starting-style:-translate-y-1 data-starting-style:opacity-0`}
      >
        {children}
      </MenuContent>
    </SdkMenu>
  );
}

/**
 * One action. `danger` marks one that removes something. `disabled` says why it can't run now:
 * the item stays focusable and shows the reason under its name. Return a Promise from `onSelect`
 * to keep the item busy until it settles.
 */
export function MenuItem({ icon: Icon, danger = false, disabled, shortcut, onSelect, children }: { icon?: LucideIcon; danger?: boolean; disabled?: string | false; shortcut?: string; onSelect?: () => unknown; children: ReactNode }) {
  return (
    <SdkMenuItem
      disabled={!!disabled}
      destructive={danger}
      shortcut={shortcut}
      onSelect={onSelect ? () => onSelect() : undefined}
      className={`${ROW} ${danger ? "text-fail" : ""} data-pending:cursor-progress`}
    >
      {Icon && (
        <MenuItemIcon className={`flex-none self-start pt-0.5 ${danger ? "" : "text-icon"} ${disabled ? "opacity-45" : ""}`}>
          <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
        </MenuItemIcon>
      )}
      <span className="min-w-0 flex-1">
        <span className={disabled ? "opacity-45" : undefined}>{children}</span>
        {disabled && <span className="block text-xs text-muted">{disabled}</span>}
      </span>
      {shortcut && <MenuShortcut className="ml-4 flex-none text-xs text-muted" />}
    </SdkMenuItem>
  );
}

/** A line between groups of actions. */
export function MenuSeparator() {
  return <SdkMenuSeparator className="mx-1 my-1 h-px bg-line" />;
}

/** A named pick of one value inside a menu, such as "Group by", with a check on the chosen one. */
export function MenuChoice<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (value: T) => void; options: readonly { value: T; label: string }[] }) {
  return (
    <MenuGroup>
      <MenuGroupLabel className="px-2 pt-2 pb-1 text-xs font-medium text-muted">{label}</MenuGroupLabel>
      <MenuRadioGroup value={value} onValueChange={(next) => onChange(next as T)}>
        {options.map((option) => (
          <MenuRadioItem key={option.value} value={option.value} closeOnSelect={false} className={ROW}>
            <span className="min-w-0 flex-1">{option.label}</span>
            <MenuItemIndicator className="flex-none">
              <Check size={16} strokeWidth={1.5} aria-hidden="true" />
            </MenuItemIndicator>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </MenuGroup>
  );
}
