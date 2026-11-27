/**
 * Configuration constants for @sous-run/engine.
 */

/** The agent, code and checkpoint calls a dry run may make. A real run has no cap unless it sets
 *  maxAgents. A dry run starts no program, so a loop in its script would never end. */
export const DRY_RUN_MAX_CALLS = 1000;

/** Maximum concurrent agents (matches Claude Code limit). */
export const MAX_CONCURRENCY = 16;

/** Maximum automatic retry attempts after a recoverable agent failure. */
export const MAX_AGENT_RETRIES = 4;
