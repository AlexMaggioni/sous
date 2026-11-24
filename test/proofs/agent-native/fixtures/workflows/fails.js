export const meta = {
  name: "fails",
  description: "Prepare, then run a check that fails",
  place: "none",
}

await sh("echo prepared", { label: "prepare" })
await sh("echo 'disk check failed' >&2; exit 3", { label: "boom" })
return "done"
