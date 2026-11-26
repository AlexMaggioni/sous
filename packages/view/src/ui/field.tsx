// Form fields, for the start dialog's inputs and for answers: a label, a hint, the control and its error, as the mock's .fld.
import { Checkbox, CheckboxIndicator } from "@ui-sdk/react/checkbox";
import { FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet, Field as SdkField } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { Select, SelectContent, SelectItem, SelectItemIndicator, SelectTrigger, SelectValue } from "@ui-sdk/react/select";
import { Textarea } from "@ui-sdk/react/textarea";
import { Check, ChevronDown, CircleAlert } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import type { Input as InputSpec } from "../api/contract.ts";
import { POPUP } from "./motion.ts";

// Inputs sit on --bg-raised with a --border-strong line, 32px tall and 40px under 700px.
const CONTROL =
  "w-full min-w-0 rounded-md border border-line-strong bg-raised px-2.5 text-fg placeholder:text-muted aria-invalid:border-fail data-disabled:cursor-not-allowed data-disabled:opacity-45";
const ROW =
  "flex min-h-7 w-full cursor-default items-center gap-2 rounded-md px-2 py-1 text-left outline-none select-none data-disabled:opacity-45 data-highlighted:bg-hover max-[699px]:min-h-10";

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <FieldError match className="mt-1 flex items-start gap-1.5 text-xs text-fail">
      <CircleAlert size={14} strokeWidth={1.5} aria-hidden="true" className="mt-px flex-none" />
      {children}
    </FieldError>
  );
}

export type FieldProps = {
  /** What to fill in. */
  label: ReactNode;
  /** A muted word after the label, such as "required", "optional" or "default 3". */
  note?: string;
  /** A muted line under the label. When the field is disabled, it says why. */
  description?: ReactNode;
  /** What is wrong and how to fix it. It marks the control invalid. */
  error?: string;
  /** The name the control submits under, read with FormData. */
  name?: string;
  disabled?: boolean;
  children: ReactNode;
};

/** A label above one control, with its hint and its error. The control inside takes the label as its name. */
export function Field({ label, note, description, error, name, disabled, children }: FieldProps) {
  return (
    <SdkField name={name} disabled={disabled} invalid={error ? true : undefined} className="flex min-w-0 flex-col">
      <FieldLabel className="flex items-baseline gap-2 font-medium">
        {label}
        {note && <span className="text-xs font-normal text-muted">{note}</span>}
      </FieldLabel>
      {description && <FieldDescription className="mt-0.5 text-xs text-muted">{description}</FieldDescription>}
      <div className="mt-1.5">{children}</div>
      {error && <ErrorLine>{error}</ErrorLine>}
    </SdkField>
  );
}

type InputProps = Omit<ComponentProps<typeof Input>, "className" | "render">;

/** A one-line text or number input. `mono` is for values such as a branch or a path. */
export function TextInput({ mono = false, ...props }: InputProps & { mono?: boolean }) {
  return <Input autoComplete="off" spellCheck={false} {...props} className={`${CONTROL} h-8 max-[699px]:h-10 ${mono ? "font-mono text-xs" : ""}`} />;
}

type TextareaProps = Omit<ComponentProps<typeof Textarea>, "className" | "render">;

/** A text area that grows with its text, such as an answer or a JSON value. */
export function TextArea({ mono = false, ...props }: TextareaProps & { mono?: boolean }) {
  return <Textarea autoResize {...props} className={`${CONTROL} block min-h-16 resize-y py-1.5 ${mono ? "font-mono text-xs leading-[18px]" : ""}`} />;
}

export type Option = string | { value: string; label: string };

/** A pick of one value from a list that opens under it. A string option is its own label. */
export function SelectInput({ options, placeholder = "Choose one", name, value, defaultValue, onValueChange, required, disabled }: { options: readonly Option[]; placeholder?: string; name?: string; value?: string; defaultValue?: string; onValueChange?: (value: string) => void; required?: boolean; disabled?: boolean }) {
  const items = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  return (
    <Select
      items={items}
      placeholder={placeholder}
      name={name}
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange ? (next) => next !== null && onValueChange(String(next)) : undefined}
      required={required}
      disabled={disabled}
    >
      <SelectTrigger className={`${CONTROL} flex h-8 items-center justify-between gap-2 text-left max-[699px]:h-10`}>
        <SelectValue className="min-w-0 truncate data-placeholder:text-muted" />
        <ChevronDown size={16} strokeWidth={1.5} aria-hidden="true" className="flex-none text-icon" />
      </SelectTrigger>
      <SelectContent
        side="bottom"
        align="start"
        sideOffset={4}
        collisionPadding={8}
        alignItemWithTrigger={false}
        className={`z-50 m-0 max-h-(--available-height) min-w-(--anchor-width) overflow-y-auto rounded-lg border border-line bg-raised p-1 text-fg ${POPUP} data-ending-style:opacity-0 data-starting-style:-translate-y-1 data-starting-style:opacity-0`}
      >
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value} className={ROW}>
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            <SelectItemIndicator className="flex-none">
              <Check size={16} strokeWidth={1.5} aria-hidden="true" />
            </SelectItemIndicator>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A checkbox with its text beside it. Pressing the text toggles it. */
export function CheckboxInput({ children, name, checked, defaultChecked, onCheckedChange, required, disabled }: { children: ReactNode; name?: string; checked?: boolean; defaultChecked?: boolean; onCheckedChange?: (checked: boolean) => void; required?: boolean; disabled?: boolean }) {
  return (
    <label className="flex max-w-[640px] cursor-pointer items-start gap-2 py-0.5 has-data-disabled:cursor-not-allowed has-data-disabled:opacity-45">
      <Checkbox
        name={name}
        checked={checked}
        defaultChecked={defaultChecked}
        onCheckedChange={onCheckedChange ? (next) => onCheckedChange(next === true) : undefined}
        required={required}
        disabled={disabled}
        className="mt-0.5 grid size-4 flex-none place-items-center rounded-sm border border-line-strong bg-raised text-on-ink data-checked:border-ink data-checked:bg-ink max-[699px]:mt-0 max-[699px]:size-5"
      >
        <CheckboxIndicator>
          <Check size={12} strokeWidth={2} aria-hidden="true" />
        </CheckboxIndicator>
      </Checkbox>
      <span className="min-w-0">{children}</span>
    </label>
  );
}

/** The note after an input's name: required, its default, or optional. */
function noteOf(input: InputSpec): string {
  if (input.required) return "required";
  if (input.default !== undefined) return `default ${JSON.stringify(input.default)}`;
  return "optional";
}

/**
 * One input of a workflow, as the start dialog asks for it. A string with choices is a select, a
 * number a number field, a boolean a checkbox, and json a text area in mono. Each starts at its
 * default and submits under the input's name, so the form reads every value with FormData.
 */
export function InputField({ input, error }: { input: InputSpec; error?: string }) {
  const label = <code className="font-mono text-xs font-normal">{input.name}</code>;
  const fallback = input.default === undefined ? undefined : input.default;
  if (input.type === "boolean") {
    return (
      <FieldSet className="m-0 min-w-0 border-0 p-0">
        <FieldLegend className="flex items-baseline gap-2 p-0 font-medium">
          {label}
          <span className="text-xs font-normal text-muted">{noteOf(input)}</span>
        </FieldLegend>
        <div className="mt-1.5">
          <CheckboxInput name={input.name} defaultChecked={fallback === true}>
            {input.description ?? input.name}
          </CheckboxInput>
        </div>
      </FieldSet>
    );
  }
  const text = fallback === undefined ? undefined : typeof fallback === "string" ? fallback : JSON.stringify(fallback, null, input.type === "json" ? 2 : 0);
  return (
    <Field label={label} note={noteOf(input)} description={input.description} error={error} name={input.name}>
      {input.choices?.length ? (
        <SelectInput options={input.choices} defaultValue={text} required={input.required} />
      ) : input.type === "json" ? (
        <TextArea mono defaultValue={text} required={input.required} />
      ) : (
        <TextInput type={input.type === "number" ? "number" : "text"} inputMode={input.type === "number" ? "decimal" : undefined} mono={input.type === "number"} defaultValue={text} required={input.required} />
      )}
    </Field>
  );
}
