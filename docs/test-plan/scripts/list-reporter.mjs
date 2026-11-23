// A node:test reporter that prints one JSON line per test: file, line, name path, duration, type.
export default async function* (source) {
  const stack = [];
  for await (const event of source) {
    if (event.type === "test:start") { stack.length = event.data.nesting; stack.push(event.data.name); }
    if (event.type === "test:pass" || event.type === "test:fail") {
      const d = event.data;
      const path = stack.slice(0, d.nesting).concat(d.name);
      yield JSON.stringify({ ok: event.type === "test:pass", file: d.file, line: d.line, name: d.name, path, nesting: d.nesting, type: d.details?.type ?? "test", ms: d.details?.duration_ms, skip: d.skip, todo: d.todo }) + "\n";
    }
  }
}
