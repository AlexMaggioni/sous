export const meta = {
  name: "review",
  description: "Draft release notes, then stop for a person to approve them",
  place: "none",
}

const draft = await breakpoint(
  "Approve the release notes",
  () => js("return 'v1.2: faster start'", null, { label: "draft" }),
  { show: (step) => step.result },
)
return { notes: draft.result }
