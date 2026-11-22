export const meta = {
  name: "fanout",
  description: "Parallel agent steps, a shell step and a nested workflow",
  place: "folder",
}

phase("fan out")
const [left, right] = await parallel([
  () => agent("FANOUT-LEFT Name one file.", { label: "left" }),
  () => agent("FANOUT-RIGHT Name one test.", { label: "right", model: "claude/haiku" }),
])
const listed = await sh("ls -1 src test && git rev-parse --is-inside-work-tree", { label: "list files" })
phase("nest")
const child = await workflow("child", { topic: "nested" }, { label: "child run" })
return { left, right, files: listed.stdout.trim().split("\n"), child }
