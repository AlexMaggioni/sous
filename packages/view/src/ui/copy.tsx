// The copy button, and a sous command in mono with its copy button, as the mock's .cmd. Once the
// copy lands, the button draws a check for a moment.
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { IconButton } from "./button.tsx";
import { toast } from "./toast.tsx";

/** How long the check shows after a copy. */
const CHECK_MS = 1200;

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied", { command: text });
    return true;
  } catch {
    toast("The browser blocked the copy. Select the text instead.");
    return false;
  }
}

/** Copies `text` and says so in a toast. `label` names what it copies, such as "Copy the run id". */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(0);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(0), CHECK_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <IconButton
      icon={copied ? Check : Copy}
      label={label}
      size="sm"
      data-copied={copied ? "" : undefined}
      onClick={async () => {
        if (await copy(text)) setCopied(Date.now());
      }}
    />
  );
}

/** A command to run in the terminal, such as `sous run fix-tests`, in mono on a gray fill. It wraps at spaces and slashes. */
export function CommandBox({ command, label = "Copy the command" }: { command: string; label?: string }) {
  return (
    <span className="inline-flex min-h-[26px] max-w-full items-center gap-1 rounded-md bg-hover pl-2 font-mono text-xs">
      <code className="min-w-0 py-1 leading-[18px] [overflow-wrap:anywhere]">{command}</code>
      <CopyButton text={command} label={label} />
    </span>
  );
}
