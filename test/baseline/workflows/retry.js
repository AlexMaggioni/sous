export const meta = {
  name: "retry",
  description: "A step that fails once and is retried, and one with no retries that pauses the run",
  place: "none",
}

const again = await agent("RETRY-AUTO Try twice.", { label: "retried" })
const once = await agent("RETRY-NONE Try once.", { label: "no retries", retries: 0 })
const code = await sh("exit 3", { label: "failing code", allowFail: true })
return { again, once, code: code.code }
