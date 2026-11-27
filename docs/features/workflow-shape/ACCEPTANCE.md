# Workflow shape: acceptance scenarios

Draft. These scenarios say what a person can do once the workflow redesign works. The build is
done when each one passes.

## The intent

Everything a person can do by opening sessions by hand must also work in a workflow: typing
prompts, slash commands and skills such as `/goal`, keeping a session open or starting fresh,
handoff documents, linking sessions one by one. A workflow adds structure, reuse, checks and
resume. It never removes a feature a plain session has.

The owner's requirements:

- A prompt goes in as written. A leading slash command or skill works by default, with no
  special option.
- Every step kind takes optional structured input, gives optional structured output, and has a
  clear end signal. An agent step ends when the agent says it is done, not at its first turn end.
- A session can stay open across steps, for example implementer, then reviewer, then the same
  implementer session again. A step can also start a fresh session.
- A worktree can belong to the whole run, to one nested workflow or to one step. An implementer
  and reviewer loop shares one worktree. An epic workflow gives each ticket workflow its own.
- Agents can talk to each other, and a given agent can be kept alone.
- When an agent in a hands-off run needs the person, sous tells them to step into that agent's
  live session. They ask it questions and answer it there. sous has no other channel for an
  agent's questions.
- Stepping into one session stops nothing else. The other steps of the run keep going, as two
  sessions opened by hand do.
- Every limit is off unless the script sets one.

## How each scenario proves itself

- It fails on sous 0.1.0 first, then passes.
- It has a deterministic version with stand-in answers and no tokens, for the mechanism, and a
  live version on a small fixture repository, for real agents. Live versions run only behind an
  environment variable, on the smallest model of each program, since they test sous and not the
  model.
- A live scenario that needs the person is run by the agent that builds sous. It drives the page
  with a browser and the program's terminal screen through tmux.
- A script decides the result: a canary word present or absent, tests passing, a branch with the
  expected diff, one session id. A canary is a made-up word such as `PELICAN-4417` given to one
  agent only. Whether a later answer contains it shows which conversation a session remembers.

## A step is a session

1. **A skill runs from the prompt.** A fixture repository has a project skill `canary` with
   `disable-model-invocation: true`, so the model can't load it on its own. Its only instruction
   is "answer with PELICAN-4417". A step with the prompt `/canary` returns that word. The same
   holds for a user skill and a plugin skill. Today the `Task label:` line in front of the prompt
   stops the command.
2. **`/goal` holds a long task.** A fixture repository has 12 stubbed functions and a test for
   each. One step sends `/goal every test in test/ passes`. The step returns only when the tests
   pass, and `npm test` run by the script afterward exits 0. The page shows the goal's turns
   inside one step. Today the label line in front of the prompt stops `/goal`, and the step
   returns after its first turn. Run through the SDK by hand, with the prompt as written,
   `/goal` already loops until the goal is met.
3. **The agent says when it is done.** The same repository, without `/goal`. When the agent
   stops early or asks "Should I continue?", sous sends it back to work in the same session. The
   step returns only with the done signal, and the tests pass. A dry run with scripted answers
   `working, working, done` shows three turns and no model call.
4. **Structured in, structured out.** A planner step returns `{ tickets: [...] }` against a
   schema. Each ticket goes into a nested workflow as typed input, and each returns
   `{ branch, summary, tests }`. A ticket missing a required field fails before the nested
   workflow's first step runs.

## Sessions kept, fresh or forked

5. **The implementer remembers, the reviewer starts fresh.** The implementer's first prompt holds
   the canary. The reviewer asks for a change. The implementer's next turn is asked to put the
   canary in a comment, and it can. The reviewer, asked for the canary, cannot. Every implementer
   turn shows one session id.
6. **Fresh and fork behave as by hand.** A fresh session does not know the canary. A fork does.
   A second canary given to the fork never reaches the original.
7. **A stop does not lose the session.** `sous stop <run> --step implementer` during the
   implementer's third turn pauses the run. Then `sous resume`. The implementer still knows the
   canary, and finished turns are not paid for again. Killing the worker during that turn gives
   the same result.

## Worktrees

8. **The ticket loop works in one worktree.** The implementer and the reviewer see the same
   files. The person's own checkout does not change. After the run, the branch exists with the
   ticket's commits.
9. **The epic gives each ticket its own worktree.** An epic with three tickets that touch the
   same file runs three ticket workflows in parallel. Three branches exist, each with only its
   ticket's change. Kill sous during ticket 2 and resume: tickets 1 and 3 replay from the
   journal, and ticket 2 continues in its own worktree and session.

## Collaboration and agents kept apart

10. **A room actually talks.** Claude and GPT each get a different canary while they work alone.
    They meet in a room with a mediator. The decision contains both canaries, so information
    crossed between them.
11. **An agent kept alone hears nothing.** A third agent in the same run, outside the room,
    cannot name either canary.

## A person in the loop

12. **The agent needs you, and you step in.** A hands-off run reaches an ambiguous requirement,
    such as "return 404 or an empty list?". The person gets a notice that names the agent and the
    command to step in, and no question to answer. They open the agent's live session, ask "what
    did you find that makes you unsure?", get an answer from its context, and answer it. When
    they quit, the step goes on in the same session. Meanwhile another branch of the run kept
    working. Passes when the person never had to read the code, no step restarted, and the other
    branch never waited.
13. **Step into a running session.** Two agents work in parallel. The person steps into one of
    them while it runs, does part of the work by hand, and quits. Only that agent's turn
    stopped. The workflow continues from where they stopped, and the other agent never paused.

## Hands-off

14. **An overnight run survives limits.** A run hits the usage limit in the middle of an
    implementer turn. It pauses, and the sous service resumes it after the reset. It continues
    the same session in the same worktree. No finished work runs again. This scenario has no live test, by the owner's
    choice. A test with a stand-in program covers it.

## The capstone

15. **The owner's own build process as one workflow.** The owner runs a multi-agent build by
    hand: a build planner writes tickets, an implementer works each ticket in its own folder, a
    reviewer reads each change, and a verifier proves each gate. Ported to one sous workflow, a
    real stage runs hands-off. Passes when the result matches or beats a manual run, with fewer of
    the owner's actions.
