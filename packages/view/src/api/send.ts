// How the page sends one sous command: through /api/call, with a toast in the button's verb and
// the same command as the terminal takes it. Every page sends its commands this way.
import { useCallback, useState } from "react";
import { toast } from "../ui/toast.tsx";
import type { CallReply } from "./contract.ts";
import { useCall } from "./queries.ts";

export type Sent = Extract<CallReply, { ok: true }>;

/** One word as a shell reads it: bare when it is safe, else in single quotes, which keep every character as it is. */
function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The terminal command for an argv, such as `sous answer q-1 'yes please'`. */
export function commandOf(argv: readonly string[]): string {
  return ["sous", ...argv.map(shellWord)].join(" ");
}

/**
 * Sends one sous command and says what it did. On success, a toast in the button's verb with the
 * command, then one toast per note of the reply. A refusal stays in `error` for the Refusal part.
 * `pending` is true while a command is on its way.
 */
export function useSend() {
  const call = useCall();
  const { mutateAsync } = call;
  const [error, setError] = useState<unknown>(null);
  const send = useCallback(
    async (argv: string[], said: (reply: Sent) => string): Promise<Sent | null> => {
      setError(null);
      try {
        const reply = await mutateAsync(argv);
        toast(said(reply), { command: commandOf(argv) });
        for (const note of reply.notes) toast(note);
        return reply;
      } catch (thrown) {
        setError(thrown);
        return null;
      }
    },
    [mutateAsync],
  );
  const clear = useCallback(() => setError(null), []);
  return { send, error, clear, pending: call.isPending };
}

export type Send = ReturnType<typeof useSend>["send"];
