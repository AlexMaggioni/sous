// What toast() and confirm() open, mounted once at the root in main.tsx.
import { ConfirmHost } from "./confirm.tsx";
import { Toasts } from "./toast.tsx";

export function Overlays() {
  return (
    <>
      <Toasts />
      <ConfirmHost />
    </>
  );
}
