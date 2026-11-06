import { Schema, SchemaIssue } from 'effect';
/**
 * Subagent limits the USER sets (Settings → Subagents → Subagent limits). They ride
 * every request as `runtimeData.subagentSettings`; no constant stands in for
 * them. Two tiers:
 *
 * - TREE limits for one root turn and every descendant: `maxDepth`,
 *   `maxInvocations`, and `maxConcurrentWork`, which sizes the turn's work queue.
 * - PER-CHILD limits: steps, the runtime limit, and the output one working step
 *   or the summary step may produce.
 *
 * The output limits are `null` (Off) by default, like the runtime: a subagent's
 * step may produce as much as its model allows, as the main agent's may.
 */
export interface RuntimeSubagentSettings {
  /** Wall-clock limit on one child execution; `null` is Off (the default). */
  maxChildRuntimeMs: number | null;
  /** Model calls one child may make, its reserved summary step included; a persona that declares fewer keeps its own. */
  maxChildSteps: number;
  /** Tree: model/tool operations running at once across all descendants. */
  maxConcurrentWork: number;
  /** Tree: descendant levels below the root. */
  maxDepth: number;
  /** Tree: delegations one original root turn admits, resumes and descendants included. */
  maxInvocations: number;
  /** Output one working step may produce; `null` is Off (the default): the model's own limit. A step cut here fails the child. */
  maxStepOutputTokens: number | null;
  /** Output the reserved summary step may produce; `null` is Off (the default). A summary cut here returns truncated, not failed. */
  synthesisOutputTokens: number | null;
}
/**
 * The longest delay Node's `setTimeout` arms: anything above it (Infinity
 * included) or below 1 is clamped to 1 ms and fires IMMEDIATELY.
 */
export const NODE_TIMER_MAX_MS = 2_147_483_647;
/*
 * Tree ranges and defaults follow the long-horizon agents surveyed in
 * docs/superpowers/research/2026-09-22-agent-timeout-and-budget-standards.md
 * (the "research doc" below).
 */
/**
 * Up to 1,000 invocations, the same ceiling as `maxChildSteps`: Claude Code
 * sets no total subagent cap at all (research doc §1), so a long-horizon turn
 * needs a high one.
 */
const MAX_INVOCATIONS = 1000;
export const SUBAGENT_SETTINGS_LIMITS = Object.freeze({
  maxChildRuntimeMs: Object.freeze({ max: NODE_TIMER_MAX_MS, min: 1000 }),
  maxChildSteps: Object.freeze({ max: 1000, min: 1 }),
  /**
   * Up to 20 at once: the highest documented default, Claude Code's subagent
   * concurrency (research doc §1).
   */
  maxConcurrentWork: Object.freeze({ max: 20, min: 1 }),
  /**
   * Up to 8 levels: the shipped parent stream watchdog unwrapped at most eight
   * nested delegation envelopes (`MAX_DELEGATED_ENVELOPE_UNWRAPS` in
   * `packages/agent/src/mastra/agent-streaming.ts`, removed with ADR-0022), so
   * a deeper foreground descendant's tool calls would lose their tool-execution
   * window. The host enforces `maxDepth` in `packages/agent-host/src/child-runs.ts`
   * and its run-stream watchdog unwraps no envelopes, so the ceiling of 8 is
   * retained but no longer follows from a technical limit.
   */
  maxDepth: Object.freeze({ max: 8, min: 1 }),
  maxInvocations: Object.freeze({ max: MAX_INVOCATIONS, min: 1 }),
  maxStepOutputTokens: Object.freeze({ max: 65_536, min: 256 }),
  synthesisOutputTokens: Object.freeze({ max: 8192, min: 256 }),
});
/**
 * 200 per turn: Claude Code's per-session subagent total before it removed
 * that cap outright (research doc §1). A turn is narrower than a session, so
 * the default does not end real work, yet it still bounds how many times
 * background children may wake the parent in one leg.
 */
const DEFAULT_MAX_INVOCATIONS = 200;
export const DEFAULT_RUNTIME_SUBAGENT_SETTINGS: RuntimeSubagentSettings = Object.freeze({
  maxChildRuntimeMs: null,
  maxChildSteps: 100,
  /**
   * 6: Codex's default agent-thread cap, the lower of the two documented
   * defaults (Claude Code allows 20; research doc §1, §3).
   */
  maxConcurrentWork: 6,
  /** 3: Claude Code's default subagent nesting depth (research doc §1). */
  maxDepth: 3,
  maxInvocations: DEFAULT_MAX_INVOCATIONS,
  /**
   * Off: a step capped below what the model wants to write ends the subagent
   * as failed, and adaptive thinking spends much of a step's output before the
   * answer. The surveyed agents leave run-ending token budgets opt-in
   * (research doc, "Synthesis" point 5).
   */
  maxStepOutputTokens: null,
  synthesisOutputTokens: null,
});
function bounded(limit: { readonly max: number; readonly min: number }) {
  return Schema.Int.check(Schema.isGreaterThanOrEqualTo(limit.min)).check(
    Schema.isLessThanOrEqualTo(limit.max)
  );
}
export const runtimeSubagentSettingsSchema = Schema.Struct({
  maxChildRuntimeMs: Schema.NullOr(bounded(SUBAGENT_SETTINGS_LIMITS.maxChildRuntimeMs)),
  maxChildSteps: bounded(SUBAGENT_SETTINGS_LIMITS.maxChildSteps),
  maxConcurrentWork: bounded(SUBAGENT_SETTINGS_LIMITS.maxConcurrentWork),
  maxDepth: bounded(SUBAGENT_SETTINGS_LIMITS.maxDepth),
  maxInvocations: bounded(SUBAGENT_SETTINGS_LIMITS.maxInvocations),
  maxStepOutputTokens: Schema.NullOr(bounded(SUBAGENT_SETTINGS_LIMITS.maxStepOutputTokens)),
  synthesisOutputTokens: Schema.NullOr(bounded(SUBAGENT_SETTINGS_LIMITS.synthesisOutputTokens)),
});
export class RuntimeSubagentSettingsError extends Error {
  override readonly name = 'RuntimeSubagentSettingsError';
}
/**
 * `undefined` (field absent: older clients, web) → the defaults. ANY present
 * value is validated strictly and a malformed one THROWS — the host never
 * clamps or coerces a budget it was handed.
 */
export function parseRuntimeSubagentSettings(value: unknown): RuntimeSubagentSettings {
  if (value === undefined) {
    return DEFAULT_RUNTIME_SUBAGENT_SETTINGS;
  }
  const parsed = Schema.decodeUnknownResult(runtimeSubagentSettingsSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(value);
  if (!(parsed._tag === 'Success')) {
    const issues = SchemaIssue.makeFormatterStandardSchemaV1()(parsed.failure.issue)
      .issues.map(
        (issue) =>
          `${(issue.path ?? []).map((segment) => (typeof segment === 'object' ? segment.key : segment)).join('.') || '<root>'}: ${issue.message}`
      )
      .join('; ');
    throw new RuntimeSubagentSettingsError(`Subagent settings are malformed: ${issues}`);
  }
  return parsed.success;
}
/**
 * The deadline the host hands Mastra for one background child execution.
 * Mastra 1.64 arms `setTimeout(task.timeoutMs)` for EVERY task and has no
 * "none", so Off resolves to the longest timer Node can arm (~24.8 days);
 * liveness is the inactivity watchdog's job, not this deadline's
 * (docs/superpowers/research/2026-09-22-agent-timeout-and-budget-standards.md).
 */
export function resolveChildTaskTimeoutMs(
  settings: Pick<RuntimeSubagentSettings, 'maxChildRuntimeMs'>
): number {
  return settings.maxChildRuntimeMs ?? NODE_TIMER_MAX_MS;
}
