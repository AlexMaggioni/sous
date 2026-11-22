export const meta = {
  name: "stop-step",
  description: "Two steps at once; the test stops the slow one, then resumes the run",
  place: "none",
}

const [slow, quick] = await parallel([
  () => agent("STOP-SLOW Take your time.", { label: "slow" }),
  () => agent("STOP-QUICK Answer now.", { label: "quick" }),
])
const after = await agent("STOP-AFTER Wrap up.", { label: "after" })
return { slow, quick, after }
