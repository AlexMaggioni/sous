export const meta = {
  name: "places",
  description: "Report where the run works",
  place: "folder",
}

const where = await sh('if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo "git $(git rev-parse --abbrev-ref HEAD)"; else echo "no git"; fi; ls -1 | head -3', {
  label: "where",
})
const said = await agent("PLACES Say where you are.", { label: "where agent" })
return { where: where.stdout.trim().split("\n"), said }
