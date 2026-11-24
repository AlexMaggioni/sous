# Write or change a workflow

Write or change a workflow only with the person's yes. Show them what you will save, and save
only after they agree. Save in the project's `.sous/workflows/<name>.js`. Change
`~/.sous/workflows/`, a schedule, or `startedBy` only when the person asked for that.

Start from a workflow that exists. `sous workflows --json` lists them. Before you change or run
one you don't know, read `sous workflows show <name> --json`: its steps, inputs, approval and
last runs. `sous agents --json` lists the agents a step can name.

## The person approves it

sous keeps the person's yes for each workflow's exact text. A new or changed workflow does not
start from an agent, a step of a run or a schedule until the person approves it. A scheduled run of
it is skipped, and the person gets a notice. Once you saved it and the check passes, show them
`sous workflows show <name> --diff --json`, what changed since their last yes. Tell them sous
starts it from you, a run or a schedule only after they approve it, by saying yes to you or with
`sous workflows approve <name>` in their own terminal.

When they say yes to you, run `sous workflows approve <name> --by person --json`. Without
`--by person` an agent's approve is refused with `needs_person`. Never approve without their yes.
A person's own `sous run <name>` approves the text it runs. Never edit, move or delete
`approvals.json` or `approved/` in sous's home. Without them no workflow counts as approved.

## The file

```js
export const meta = {
  name: "ticket",
  description: "Implement a ticket, review it",
  inputs: {
    ticket: { type: "string", description: "What to build", required: true },
    rounds: { type: "number", default: 3 },
  },
  outputs: { summary: "What was built" },
  place: "worktree",
  startedBy: "anyone",
  timeout: "2h",
}

const built = await agent(`Implement this ticket:\n${args.ticket}`, { agentType: "implementer", label: "implementer", keepSession: true })
const review = await agent(`Review the change for: ${args.ticket}`, { agentType: "reviewer", label: "reviewer" })
await agent(`Address this review:\n${review}`, { continue: "implementer" })
return { summary: built }
```

- `meta` needs `name` and `description`. `inputs` become flags of `sous run`.
- Give every step a `label`. Resume matches steps by prompt, options and label.
- `Math.random()`, `Date.now()` and `new Date()` with no argument throw. A resume replays the
  script and must take the same path. Pass a time or a random value as an input.
- Cap each loop, usually with an input such as `rounds`.

## Steps

- `agent(prompt, options)` runs one agent. Options include `label`, `agentType`, `model`,
  `schema`, `timeout`, `skills`, `mcp`, `keepSession`, `continue` and `ask`.
- `sh`, `js`, `py`, `run` and `waitUntil` run code on this machine and spend no tokens.
- `ask(question, { choices })` and `checkpoint(prompt, { kind, choices })` ask the person.
  `answeredBy: "anyone"` in `ask` lets an agent answer too. `agent()` with `ask: true` takes it.
- `breakpoint(title, step)` runs the step, then waits for the person to approve it. It is always
  for people, so it takes no `answeredBy`.
- `parallel`, `pipeline`, `retry`, `gate`, `choose` and `workflow` shape the flow.

## Check it

```sh
sous check ticket --ticket "x" --json
sous check ticket --ticket "x" --dry-run --json
sous check ticket --ticket "x" --dry-run --answers answers.json --json
```

The check parses the script, fits the inputs, and finds each agent, workflow and MCP server. A
dry run runs the workflow once with stand-in agents. It spends no tokens. Code steps run for real
in a copy, so a step that writes to `SOUS_PROJECT` still changes the project. `--answers` gives
the stand-ins' answers by step label, such as `{"reviewer *": {"approved": true}}`.

Fix what the check reports until it passes, then show the person the file and the result.
