// A keyboard key, such as ⌘K on a Mac and Ctrl+K elsewhere.
import { useShortcutHint } from "@ui-sdk/react/shortcuts";

// A named key pressed alone reads as a word, as in the mock: Esc, not the Mac glyph.
const WORDS: Record<string, string> = { escape: "Esc", esc: "Esc", enter: "Enter", tab: "Tab", space: "Space", up: "Up", down: "Down", left: "Left", right: "Right" };

function Key({ keys }: { keys: string }) {
  const hint = useShortcutHint(keys);
  const word = WORDS[keys.toLowerCase().replace(/^arrow/, "")];
  return (
    <kbd className="inline-block min-w-5 rounded-sm border border-line-strong bg-raised px-[5px] text-center font-mono text-xs leading-[18px] text-muted">
      {word ?? hint.text}
    </kbd>
  );
}

/** Keys joined with "+" press together, as "mod+k". Keys split by a space press in turn, as "g r" or "Up Down". */
export function Kbd({ keys }: { keys: string }) {
  const steps = keys.split(" ").filter(Boolean);
  return (
    <span className="inline-flex items-center gap-1">
      {steps.map((step, i) => (
        <Key key={`${i}-${step}`} keys={step} />
      ))}
    </span>
  );
}
