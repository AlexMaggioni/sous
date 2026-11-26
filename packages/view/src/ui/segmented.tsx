// The two-way switch of a page, such as Graph and Steps, or Rendered and Raw: quiet buttons, the chosen one filled.
// The fill slides to the choice, and holds still with less motion.
import { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem } from "@ui-sdk/react/segmented-control";
import type { ButtonSize } from "./button.tsx";

const ITEM: Record<ButtonSize, string> = { sm: "h-6 px-2 text-xs", md: "h-7 px-2.5" };

/**
 * One choice out of a few views. Arrow keys move between them and the group is one tab stop.
 * DESIGN.md keeps it out of the sidebar.
 */
export function Segmented<T extends string>({ label, value, onChange, options, size = "md" }: { label: string; value: T; onChange: (value: T) => void; options: readonly { value: T; label: string }[]; size?: ButtonSize }) {
  return (
    <SegmentedControl value={value} onValueChange={(next) => next !== null && onChange(next as T)} aria-label={label} className="relative isolate inline-flex flex-none items-center gap-0.5">
      <SegmentedControlIndicator className="absolute top-0 left-0 -z-10 h-(--segmented-control-indicator-height) w-(--segmented-control-indicator-width) translate-x-(--segmented-control-indicator-left) translate-y-(--segmented-control-indicator-top) rounded-md bg-selected transition-[translate,width] duration-(--base) data-[activation-direction=none]:transition-none motion-reduce:transition-none" />
      {options.map((option) => (
        <SegmentedControlItem
          key={option.value}
          value={option.value}
          className={`${ITEM[size]} inline-flex items-center rounded-md whitespace-nowrap text-muted transition-colors select-none hover:text-fg not-data-checked:hover:bg-hover data-checked:font-medium data-checked:text-fg max-[699px]:h-10`}
        >
          {option.label}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}
