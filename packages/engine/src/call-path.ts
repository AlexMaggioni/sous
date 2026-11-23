/** Observable call-path capture format. Bump when capture semantics change. */
export const CALL_PATH_FORMAT = 1;
/** Maximum unambiguous raw stack depth retained for call-path capture. */
export const CALL_PATH_RAW_FRAMES = 64;

/**
 * The structural call-path key of the agent() or checkpoint() call being made: the line and
 * column of each script frame on the stack, innermost first. It reads the stack at the moment of
 * the call, so a caller must call it directly from the call's own start, with no helper frame in
 * between: one more host frame would change which deep stacks it refuses. A stack deeper than
 * CALL_PATH_RAW_FRAMES has no key.
 */
export function captureCallPath(vmFilename: string, preludeLines: number): string | undefined {
  const originalPrepareStackTrace = Error.prepareStackTrace;
  const originalStackTraceLimit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = CALL_PATH_RAW_FRAMES + 1;
    Error.prepareStackTrace = (_error, stack) => stack;
    const raw = new Error().stack as unknown as NodeJS.CallSite[];
    if (!Array.isArray(raw) || raw.length === CALL_PATH_RAW_FRAMES + 1) return undefined;

    const selected: NodeJS.CallSite[] = [];
    let selecting = false;
    for (const frame of raw) {
      const selectable = frame.getFileName() === vmFilename && !frame.isAsync();
      if (!selecting) {
        if (!selectable) continue;
        selecting = true;
      } else if (!selectable) {
        break;
      }
      selected.push(frame);
    }
    if (selected.length === 0) return undefined;

    const normalized: string[] = [];
    for (const frame of selected) {
      const frameLine = frame.getLineNumber();
      const column = frame.getColumnNumber();
      if (frameLine === null || column === null) return undefined;
      normalized.push(`${frameLine - (preludeLines + 1)}:${column}`);
    }
    return normalized.join("<");
  } catch {
    return undefined;
  } finally {
    Error.prepareStackTrace = originalPrepareStackTrace;
    Error.stackTraceLimit = originalStackTraceLimit;
  }
}
