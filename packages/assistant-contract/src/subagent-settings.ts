import { z } from 'zod';

/**
 * Subagent limits the USER sets (Settings → Subagents → Subagent limits). They ride
 * every request as `runtimeData.subagentSettings`; no constant stands in for
 * them. Two tiers:
 *
 * - TREE limits, one set per original root turn across resumes and every
 *   descendant: `maxDepth`, `maxInvocations`, `maxTreeOutputTokens` are copied
 *   into the turn's `brainstrike_delegation_budgets` row at first admission;
 *   `maxConcurrentWork` sizes each leg's work queue.
 * - PER-CHILD allocations, each within the tree: steps, summary, child and
 *   step output (copied into the same row), and the runtime limit.
 *
 * Everything the row stores is TURN-scoped (`TurnSubagentLimits`): a later
 * leg of the same turn reads it back from the row (`applyTurnSubagentLimits`)
 * so it never enforces or tells the model different limits than the host
 * admitted under. `maxConcurrentWork` and `maxChildRuntimeMs` are PER-REQUEST.
 */
export interface RuntimeSubagentSettings {
  maxChildOutputTokens: number;
  /** Wall-clock limit on one child execution; `null` is Off (the default). */
  maxChildRuntimeMs: number | null;
  maxChildSteps: number;
  /** Tree: model/tool operations running at once across all descendants. */
  maxConcurrentWork: number;
  /** Tree: descendant levels below the root. */
  maxDepth: number;
  /** Tree: delegations one original root turn admits, resumes and descendants included. */
  maxInvocations: number;
  maxStepOutputTokens: number;
  /** Tree: output tokens across every descendant of one original root turn. */
  maxTreeOutputTokens: number;
  synthesisOutputTokens: number;
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
const MAX_CHILD_OUTPUT_TOKENS = 131_072;
/**
 * Up to 1,000 invocations, the same ceiling as `maxChildSteps`: Claude Code
 * sets no total subagent cap at all (research doc §1), so a long-horizon turn
 * needs a high one.
 */
const MAX_INVOCATIONS = 1000;

export const SUBAGENT_SETTINGS_LIMITS = Object.freeze({
  maxChildOutputTokens: Object.freeze({ max: MAX_CHILD_OUTPUT_TOKENS, min: 1024 }),
  maxChildRuntimeMs: Object.freeze({ max: NODE_TIMER_MAX_MS, min: 1000 }),
  maxChildSteps: Object.freeze({ max: 1000, min: 1 }),
  /**
   * Up to 20 at once: the highest documented default, Claude Code's subagent
   * concurrency (research doc §1).
   */
  maxConcurrentWork: Object.freeze({ max: 20, min: 1 }),
  /**
   * Up to 8 levels: the parent stream watchdog unwraps at most eight nested
   * delegation envelopes (`MAX_DELEGATED_ENVELOPE_UNWRAPS` in
   * `packages/agent/src/mastra/agent-streaming.ts`), so a deeper foreground
   * descendant's tool calls would lose their tool-execution window.
   */
  maxDepth: Object.freeze({ max: 8, min: 1 }),
  maxInvocations: Object.freeze({ max: MAX_INVOCATIONS, min: 1 }),
  maxStepOutputTokens: Object.freeze({ max: 65_536, min: 256 }),
  /**
   * Up to every admissible invocation spending the largest per-child
   * allocation (131,072,000), which also fits the budget row's int4 columns.
   */
  maxTreeOutputTokens: Object.freeze({
    max: MAX_INVOCATIONS * MAX_CHILD_OUTPUT_TOKENS,
    min: 1024,
  }),
  synthesisOutputTokens: Object.freeze({ max: 8192, min: 256 }),
});

const DEFAULT_MAX_CHILD_OUTPUT_TOKENS = 32_768;
/**
 * 200 per turn: Claude Code's per-session subagent total before it removed
 * that cap outright (research doc §1). A turn is narrower than a session, so
 * the default does not end real work, yet it still bounds how many times
 * background children may wake the parent in one leg.
 */
const DEFAULT_MAX_INVOCATIONS = 200;

export const DEFAULT_RUNTIME_SUBAGENT_SETTINGS: RuntimeSubagentSettings = Object.freeze({
  maxChildOutputTokens: DEFAULT_MAX_CHILD_OUTPUT_TOKENS,
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
  maxStepOutputTokens: 8192,
  /**
   * Every default invocation spending its full default allocation, so the
   * tree cap never binds before the per-child and invocation caps do: the
   * surveyed agents leave run-ending token budgets opt-in (research doc,
   * "Synthesis" point 5). A user lowers it to make it a cost ceiling.
   */
  maxTreeOutputTokens: DEFAULT_MAX_INVOCATIONS * DEFAULT_MAX_CHILD_OUTPUT_TOKENS,
  synthesisOutputTokens: 2048,
});

function bounded(limit: { readonly max: number; readonly min: number }) {
  return z.number().int().min(limit.min).max(limit.max);
}

export const runtimeSubagentSettingsSchema = z
  .strictObject({
    maxChildOutputTokens: bounded(SUBAGENT_SETTINGS_LIMITS.maxChildOutputTokens),
    maxChildRuntimeMs: bounded(SUBAGENT_SETTINGS_LIMITS.maxChildRuntimeMs).nullable(),
    maxChildSteps: bounded(SUBAGENT_SETTINGS_LIMITS.maxChildSteps),
    maxConcurrentWork: bounded(SUBAGENT_SETTINGS_LIMITS.maxConcurrentWork),
    maxDepth: bounded(SUBAGENT_SETTINGS_LIMITS.maxDepth),
    maxInvocations: bounded(SUBAGENT_SETTINGS_LIMITS.maxInvocations),
    maxStepOutputTokens: bounded(SUBAGENT_SETTINGS_LIMITS.maxStepOutputTokens),
    maxTreeOutputTokens: bounded(SUBAGENT_SETTINGS_LIMITS.maxTreeOutputTokens),
    synthesisOutputTokens: bounded(SUBAGENT_SETTINGS_LIMITS.synthesisOutputTokens),
  })
  .superRefine((value, context) => {
    if (value.maxChildOutputTokens > value.maxTreeOutputTokens) {
      context.addIssue({
        code: 'custom',
        message: 'maxChildOutputTokens must not exceed maxTreeOutputTokens',
        path: ['maxChildOutputTokens'],
      });
    }
    if (value.synthesisOutputTokens > value.maxChildOutputTokens) {
      context.addIssue({
        code: 'custom',
        message: 'synthesisOutputTokens must not exceed maxChildOutputTokens',
        path: ['synthesisOutputTokens'],
      });
    }
    if (value.maxStepOutputTokens > value.maxChildOutputTokens) {
      context.addIssue({
        code: 'custom',
        message: 'maxStepOutputTokens must not exceed maxChildOutputTokens',
        path: ['maxStepOutputTokens'],
      });
    }
  });

/** The limits one original root turn freezes into its budget row at first admission. */
export type TurnSubagentLimits = Pick<
  RuntimeSubagentSettings,
  | 'maxChildOutputTokens'
  | 'maxChildSteps'
  | 'maxDepth'
  | 'maxInvocations'
  | 'maxStepOutputTokens'
  | 'maxTreeOutputTokens'
  | 'synthesisOutputTokens'
>;

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
  const parsed = runtimeSubagentSettingsSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new RuntimeSubagentSettingsError(`Subagent settings are malformed: ${issues}`);
  }
  return parsed.data;
}

/**
 * The settings one leg runs under: the turn's stored limits when its budget
 * row exists (`turn`), the request's per-request knobs always. `undefined`
 * (no row yet: the leg that first delegates opens it from this very request)
 * is the request itself. A stored row the contract rejects THROWS.
 */
export function applyTurnSubagentLimits(
  request: RuntimeSubagentSettings,
  turn: TurnSubagentLimits | undefined
): RuntimeSubagentSettings {
  if (turn === undefined) {
    return request;
  }
  return parseRuntimeSubagentSettings({ ...request, ...turn });
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
