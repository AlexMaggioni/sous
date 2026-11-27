# Write or change a workflow

Show the person what you will write or change, and save it only after their yes, in the
project's `.sous/workflows/<name>.js`. Change `~/.sous/workflows/`, a schedule, or `startedBy`
only when the person asks.

Start from a workflow that exists. `sous workflows --json` lists them. Before you change or run
one you don't know, read `sous workflows show <name> --json`: its steps, inputs, approval and
last runs. `sous agents --json` lists the agents a step can name.

## The person approves it

sous keeps the person's yes for each workflow's exact text. Until the person approves a new or
changed workflow, no agent, run step or schedule starts it. A scheduled run is skipped, with
a notice. Once it is saved and checked, show them `sous workflows show <name> --diff --json`,
what changed since their last yes. They approve it by saying yes to you or with
`sous workflows approve <name>` in their own terminal.

When they say yes to you, run `sous workflows approve <name> --by person --json`. Their yes
counts for the text you showed, saved unchanged. If the check made you change it, show the diff
and ask again. Without `--by person` the approve fails with `needs_person`. Never approve
without their yes. A person's own `sous run <name>` approves the text it runs. Never edit, move
or delete `approvals.json` or `approved/` in sous's home.

## The file

```js
export const meta = {
  name: "ticket",
  description: "Implement a ticket, review it",
  inputs: {
    ticket: { type: "string", description: "What to build", required: true },
  },
  outputs: { summary: "What was built" },
  place: "worktree",
}

const impl = session({ label: "implementer", agentType: "implementer" })
const built = await impl.send(`Implement this ticket:\n${args.ticket}`)
const review = await agent("Review the change", { agentType: "reviewer", label: "reviewer" })
await impl.send(`Address this review:\n${review}`, { label: "fix" })
return { summary: built }
```

- `meta` needs `name` and `description`. `inputs` become flags of `sous run`.
- Give every step a `label`. Resume matches steps by prompt, options and label.
- `Math.random()`, `Date.now()` and `new Date()` with no argument throw. A resume replays the
  script on the same path, so pass a time or a random value as an input.
- Cap each loop, such as with a `rounds` input.

## Steps

- `session({ label, agentType, model, effort, mode, skills, mcp, mcpServers, cwd })` makes a
  handle with a unique label. `<handle>.send(prompt, options)` runs a step in its session, with
  `label`, `schema`, `timeout`, `retries`, `images`, `phase`, or a `model` on its program.
- `agent(prompt, options)` is one send on a fresh session. It takes both and `place`.
- A step runs until its agent says done, or one turn with `until: "turn"`. Then `check`, a
  command or a function, runs, and a failure goes back to the agent. `maxTurns` and `maxRepairs`
  cap it when set. `ask: false` stops the agent asking the person.
- `sh`, `js`, `py`, `run` and `waitUntil` run code on this machine and spend no tokens.
- `ask(question, { choices })` asks the person. `answeredBy: "anyone"` lets an agent answer too.
- `breakpoint(title, step)` runs the step, then waits for the person to approve it. Code steps,
  `ask` and `breakpoint` take a JSON `input` and a `schema` the value must fit.
- `parallel`, `pipeline`, `choose` and `workflow` shape the flow. Write a retry as a loop.

## Check it

```sh
sous check ticket --ticket "x" --json
sous check ticket --ticket "x" --dry-run --json
```

The check parses the script, fits the inputs, and finds each agent, workflow and MCP server. A
dry run runs it once with stand-in agents, for no tokens. Code steps run for real in a copy,
but a step that writes to `SOUS_PROJECT` changes the project. `--answers` gives
the stand-ins' answers by step label, such as `{"reviewer *": {"approved": true}}`.

Fix what the check reports until it passes, then show the person the file and the result.
