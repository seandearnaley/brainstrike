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
  maxChildSteps: number;
  maxStepOutputTokens: number;
  synthesisOutputTokens: number;
}

export const SUBAGENT_SETTINGS_LIMITS = Object.freeze({
  maxChildOutputTokens: Object.freeze({ max: DELEGATION_LIMITS.maxTreeOutputTokens, min: 1024 }),
  maxChildSteps: Object.freeze({ max: 64, min: 1 }),
  maxStepOutputTokens: Object.freeze({ max: 65_536, min: 256 }),
  synthesisOutputTokens: Object.freeze({ max: 8192, min: 256 }),
});

export const DEFAULT_RUNTIME_SUBAGENT_SETTINGS: RuntimeSubagentSettings = Object.freeze({
  maxChildOutputTokens: 32_768,
  maxChildSteps: 32,
  maxStepOutputTokens: 8192,
  synthesisOutputTokens: 2048,
});

function bounded(limit: { readonly max: number; readonly min: number }) {
  return z.number().int().min(limit.min).max(limit.max);
}

export const runtimeSubagentSettingsSchema = z
  .strictObject({
    maxChildOutputTokens: bounded(SUBAGENT_SETTINGS_LIMITS.maxChildOutputTokens),
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
