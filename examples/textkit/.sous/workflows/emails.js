export const meta = {
  name: "emails",
  description: "Sort an inbox, draft replies to the emails that need one, and wait for your approval",
  inputs: {
    mailbox: {
      type: "string",
      description: "JSON file of emails, [{ id, from, subject, body }], relative to the project folder",
      default: "mail/inbox.json",
    },
  },
  outputs: { drafts: "The approved replies", skipped: "The emails that need no reply" },
  // Email touches no repo.
  place: "none",
}

const read = await js(
  `const path = require("node:path").resolve(process.env.SOUS_PROJECT ?? ".", input)
  return JSON.parse(require("node:fs").readFileSync(path, "utf8"))`,
  args.mailbox,
  { label: "read mailbox" },
)
const emails = read.result

const sorted = await agent(
  `Sort these emails.\n\n${JSON.stringify(emails, null, 2)}`,
  {
    agentType: "mail-sorter",
    label: "sort",
    schema: {
      type: "object",
      properties: {
        emails: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, reply: { type: "boolean" }, why: { type: "string" } },
            required: ["id", "reply", "why"],
          },
        },
      },
      required: ["emails"],
    },
  },
)
const toAnswer = emails.filter((e) => sorted.emails.find((s) => s.id === e.id)?.reply)
const skipped = sorted.emails.filter((s) => !s.reply)

// Draft every reply, then stop for approval. A note sends the drafts back to be redone with it.
const drafts = await breakpoint(
  "Approve these replies",
  (note) =>
    parallel(
      toAnswer.map((e) => () =>
        agent(
          `Draft a reply to this email.\n\nFrom: ${e.from}\nSubject: ${e.subject}\n\n${e.body}` +
            (note ? `\n\nThe maintainer's note on the last drafts: ${note}` : ""),
          { agentType: "mail-writer", label: `draft ${e.id}${note ? " again" : ""}` },
        ).then((reply) => ({ id: e.id, to: e.from, subject: `Re: ${e.subject}`, reply })),
      ),
    ),
  {
    show: (list) => list.map((d) => `To: ${d.to}\nSubject: ${d.subject}\n\n${d.reply}`).join("\n\n---\n\n"),
  },
)

await js(
  `const lines = input.map((d) => "To: " + d.to + "\\nSubject: " + d.subject + "\\n\\n" + d.reply).join("\\n\\n---\\n\\n")
  require("node:fs").writeFileSync("drafts.md", lines + "\\n")`,
  drafts,
  { label: "save drafts" },
)

return { drafts, skipped }
