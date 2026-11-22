export const meta = {
  name: "pause",
  description: "The test pauses the run during its first step, then resumes it",
  place: "none",
}

const first = await agent("PAUSE-FIRST Start.", { label: "first" })
const second = await agent("PAUSE-SECOND Go on.", { label: "second" })
return { first, second }
