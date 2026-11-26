// Buttons: the text button in its four kinds, and the icon button with its tooltip, as DESIGN.md says under Buttons.
import { Button as SdkButton } from "@ui-sdk/react/button";
import { Tooltip, TooltipTrigger } from "@ui-sdk/react/tooltip";
import { LoaderCircle, type LucideIcon } from "lucide-react";
import type { ComponentProps, MouseEvent, ReactNode } from "react";
import { TipContent } from "./tooltip.tsx";

/** Primary is ink, one per page at most. Secondary has a gray fill. Quiet has none until hover. Danger is secondary in red. */
export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
/** 28px in the sidebar and in small places, 32px in page headers. Every size is 40px under 700px. */
export type ButtonSize = "sm" | "md";

type Native = Omit<ComponentProps<"button">, "className" | "children" | "disabled" | "onClick">;

export type ButtonProps = Native & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  /** Shows the spinner and ignores presses, for work that runs elsewhere, such as a form's mutation. */
  busy?: boolean;
  /** Why it can't be pressed now. The button stays in the tab order and its tooltip says why. */
  disabled?: string | false;
  /** Return a Promise and the button stays busy until it settles. */
  onClick?: (event: MouseEvent<HTMLElement>) => unknown;
  /** For placement only, such as a margin. The look comes from `variant` and `size`. */
  className?: string;
  children: ReactNode;
};

/** A press sinks the button a little, and hover fills fade in. With less motion, only the fills change. */
const PRESS = "transition-[background-color,color,opacity,scale] motion-safe:active:not-aria-disabled:scale-[0.97]";

const BASE = `relative inline-flex flex-none items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap select-none aria-disabled:cursor-not-allowed aria-disabled:opacity-45 data-pending:cursor-progress max-[699px]:h-10 ${PRESS}`;

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-ink text-on-ink hover:not-aria-disabled:opacity-88",
  secondary: "bg-hover text-fg in-data-[surface=side]:bg-raised hover:not-aria-disabled:bg-selected",
  quiet: "text-muted hover:not-aria-disabled:bg-hover hover:not-aria-disabled:text-fg",
  danger: "bg-hover text-fail in-data-[surface=side]:bg-raised hover:not-aria-disabled:bg-selected",
};

const SIZE: Record<ButtonSize, string> = { sm: "h-7 px-2.5", md: "h-8 px-3" };
const ICON_PAD: Record<ButtonSize, string> = { sm: "pl-2", md: "pl-2.5" };

/** The square of an icon button: 28px with a 16px icon, or 24px with a 14px icon, and 40px under 700px. */
export function iconButtonClass(size: ButtonSize): string {
  return `inline-grid flex-none place-items-center rounded-md text-icon ${PRESS} hover:not-aria-disabled:bg-hover hover:not-aria-disabled:text-fg aria-expanded:bg-hover aria-expanded:text-fg aria-disabled:cursor-not-allowed aria-disabled:opacity-45 data-pending:cursor-progress max-[699px]:size-10 ${size === "sm" ? "size-6" : "size-7"}`;
}

/** The turning ring a busy button shows. It holds still with reduced motion. */
function Spinner({ size }: { size: number }) {
  return <LoaderCircle size={size} strokeWidth={1.5} aria-hidden="true" className="spin" />;
}

// The UI SDK button renders the tooltip's trigger, not the other way round, so a Promise from
// onClick still reaches the button and makes it pending. The tooltip stays mounted while the
// reason comes and goes, so a focused button keeps focus as it turns disabled. The trigger sets
// the type, since UI SDK's button ignores it when it renders another part.

/** A button with a sous verb as its label, such as Start, Approve or Remove. */
export function Button({ variant = "secondary", size = "md", icon: Icon, busy = false, disabled, onClick, className, children, type = "button", ...rest }: ButtonProps) {
  return (
    <Tooltip type="description" disabled={!disabled}>
      <SdkButton
        {...rest}
        render={<TooltipTrigger render={(props) => <button {...props} type={type} />} />}
        disabled={!!disabled}
        focusableWhenDisabled
        aria-busy={busy || undefined}
        data-variant={variant}
        onClick={busy ? undefined : onClick}
        pendingAnnouncement="Working"
        className={`${BASE} ${VARIANT[variant]} ${SIZE[size]} ${Icon ? ICON_PAD[size] : ""} ${className ?? ""}`}
      >
        {(state) => {
          const working = busy || state.pending;
          return (
            <>
              <span className={`inline-flex items-center gap-1.5 ${working ? "opacity-0" : ""}`}>
                {Icon && <Icon size={16} strokeWidth={1.5} aria-hidden="true" />}
                {children}
              </span>
              {working && (
                <span className="absolute inset-0 grid place-items-center">
                  <Spinner size={16} />
                </span>
              )}
            </>
          );
        }}
      </SdkButton>
      {disabled && <TipContent>{disabled}</TipContent>}
    </Tooltip>
  );
}

export type IconButtonProps = Omit<ButtonProps, "variant" | "icon" | "children" | "type"> & {
  icon: LucideIcon;
  /** The action, which names the button and fills its tooltip, such as "Hide sidebar". */
  label: string;
  /** The keys of the action, such as "mod+b", shown after the label. They aren't bound here. */
  shortcut?: string;
};

/** A gray icon in a square with no fill until hover. Its tooltip names the action and its keys. */
export function IconButton({ icon: Icon, label, shortcut, size = "md", busy = false, disabled, onClick, className, ...rest }: IconButtonProps) {
  const px = size === "sm" ? 14 : 16;
  return (
    <Tooltip type="label" shortcut={shortcut}>
      <SdkButton
        {...rest}
        render={<TooltipTrigger />}
        disabled={!!disabled}
        focusableWhenDisabled
        aria-busy={busy || undefined}
        onClick={busy ? undefined : onClick}
        pendingAnnouncement="Working"
        className={`${iconButtonClass(size)} ${className ?? ""}`}
      >
        {(state) => (busy || state.pending ? <Spinner size={px} /> : <Icon size={px} strokeWidth={1.5} aria-hidden="true" />)}
      </SdkButton>
      <TipContent shortcut={!!shortcut && !disabled}>
        {label}
        {disabled && <span className="block opacity-80">{disabled}</span>}
      </TipContent>
    </Tooltip>
  );
}
