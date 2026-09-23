import { z } from 'zod';
import { DELEGATION_LIMITS } from './delegation-limits.js';

/**
 * Per-child budgets the USER sets (Settings → Models → Subagents). They ride
 * every request as `runtimeData.subagentSettings`, the desktop host copies them
 * into the original turn's `brainstrike_delegation_budgets` row at admission,
 * and the agent derives each persona's effective step budget from them.
 *
 * `DELEGATION_LIMITS` is the tree-wide CEILING (depth, invocations,
 * concurrency, output across descendants) and is not user-settable; these
 * four are the per-child knobs that used to live there as constants (16 steps
 * / 512 synthesis tokens) and starved every repository-survey child.
 */
export interface RuntimeSubagentSettings {
  maxChildOutputTokens: number;
  /** Wall-clock limit on one child execution; `null` is Off (the default). */
  maxChildRuntimeMs: number | null;
  maxChildSteps: number;
  maxStepOutputTokens: number;
  synthesisOutputTokens: number;
}

/**
 * The longest delay Node's `setTimeout` arms: anything above it (Infinity
 * included) or below 1 is clamped to 1 ms and fires IMMEDIATELY.
 */
export const NODE_TIMER_MAX_MS = 2_147_483_647;

export const SUBAGENT_SETTINGS_LIMITS = Object.freeze({
  maxChildOutputTokens: Object.freeze({ max: DELEGATION_LIMITS.maxTreeOutputTokens, min: 1024 }),
  maxChildRuntimeMs: Object.freeze({ max: NODE_TIMER_MAX_MS, min: 1000 }),
  maxChildSteps: Object.freeze({ max: 1000, min: 1 }),
  maxStepOutputTokens: Object.freeze({ max: 65_536, min: 256 }),
  synthesisOutputTokens: Object.freeze({ max: 8192, min: 256 }),
});

export const DEFAULT_RUNTIME_SUBAGENT_SETTINGS: RuntimeSubagentSettings = Object.freeze({
  maxChildOutputTokens: 32_768,
  maxChildRuntimeMs: null,
  maxChildSteps: 100,
  maxStepOutputTokens: 8192,
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
    maxStepOutputTokens: bounded(SUBAGENT_SETTINGS_LIMITS.maxStepOutputTokens),
    synthesisOutputTokens: bounded(SUBAGENT_SETTINGS_LIMITS.synthesisOutputTokens),
  })
  .superRefine((value, context) => {
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
