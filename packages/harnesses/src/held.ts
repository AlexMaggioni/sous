// The programs an adapter keeps open between the turns of a step, one per session.

/** A program a turn kept open. fits names the settings a later turn must share to run in it. */
export interface HeldProgram {
  readonly fits: string;
  /** Whether the program still runs and waits for a turn. */
  alive(): boolean;
  /** Stops the program and settles once it has exited. It never throws. */
  close(): Promise<void>;
}

export class Held<P extends HeldProgram> {
  private readonly programs = new Map<string, P>();
  private sealed = false;

  /**
   * The session's kept program, when it still runs and its settings fit, as any of `fits` names
   * them. A program that does not fit is closed first, so the turn can resume the session in a new one.
   */
  async take(sessionId: string | undefined, fits: string | string[]): Promise<P | undefined> {
    if (sessionId === undefined) return undefined;
    const program = this.programs.get(sessionId);
    if (!program) return undefined;
    this.programs.delete(sessionId);
    if (program.alive() && (typeof fits === "string" ? [fits] : fits).includes(program.fits)) return program;
    await program.close();
    return undefined;
  }

  /** Keeps the program for the session's next turn. After release() of all, it closes it instead. */
  async keep(sessionId: string, program: P): Promise<void> {
    const earlier = this.programs.get(sessionId);
    if (earlier && earlier !== program) await earlier.close();
    if (this.sealed) {
      this.programs.delete(sessionId);
      await program.close();
      return;
    }
    this.programs.set(sessionId, program);
  }

  /** Closes the session's kept program, or every one when no session is given. */
  async release(sessionId?: string): Promise<void> {
    if (sessionId === undefined) this.sealed = true;
    const ids = sessionId === undefined ? [...this.programs.keys()] : [sessionId];
    const closing = ids.flatMap((id) => {
      const program = this.programs.get(id);
      this.programs.delete(id);
      return program ? [program.close()] : [];
    });
    await Promise.all(closing);
  }
}
