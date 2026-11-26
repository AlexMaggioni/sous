// The kit's form fields: each control alone, and each input type of a workflow as the start dialog asks for it.
import { Field, CheckboxInput, InputField, SelectInput, TextArea, TextInput } from "../ui/field.tsx";
import { INPUTS } from "./kit-data.ts";
import { KitGroup } from "./kit-section.tsx";

export function FieldsKit() {
  return (
    <>
      <KitGroup title="Fields" note="A label with a muted note, a hint, the control, and an error that says how to fix it.">
        <div className="grid max-w-[640px] gap-4">
          <Field label="Branch" note="optional" description="The branch the worktree starts from." name="branch">
            <TextInput mono placeholder="main" />
          </Field>
          <Field label="Ticket" note="required" error="Fill in ticket. sous run refuses to start without it." name="ticket-err">
            <TextInput required />
          </Field>
          <Field label="Project" description="This file lives in billing, so it runs there." disabled name="project">
            <SelectInput options={["billing", "orchestrator"]} defaultValue="billing" />
          </Field>
          <Field label="Your answer" description="The implementer waits for it." name="answer">
            <TextArea placeholder="Round once, at the end of total()." />
          </Field>
          <Field label="Model" name="model-pick">
            <SelectInput options={[{ value: "claude/opus", label: "Opus" }, { value: "claude/sonnet", label: "Sonnet" }, { value: "codex/gpt-6.1-sol", label: "GPT 6.1 Sol" }]} placeholder="The workflow's own" />
          </Field>
          <CheckboxInput name="approve">I read the changes. Approve them for every later run, then start.</CheckboxInput>
          <CheckboxInput name="disabled-check" defaultChecked disabled>
            Keep the worktree after the run
          </CheckboxInput>
        </div>
      </KitGroup>

      <KitGroup title="Workflow inputs" note="A string, a number, a pick from choices, a boolean and JSON, each at its default.">
        <form className="grid max-w-[640px] gap-4" onSubmit={(e) => e.preventDefault()}>
          {INPUTS.map((input) => (
            <InputField key={input.name} input={input} />
          ))}
        </form>
      </KitGroup>
    </>
  );
}
