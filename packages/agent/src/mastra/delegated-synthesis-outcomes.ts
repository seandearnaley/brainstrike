import type { DelegationBudgetCap } from '@brainstrike/assistant-contract';
import { z } from 'zod';
import {
  readMastraStreamPartString,
  readMastraStreamPartValue,
} from '../tool-projection/tool-event-mapper';

/**
 * What happened on a child's RESERVED SYNTHESIS step. Written by the budget
 * processor (`delegated-work-budget.ts`, the only place that knows both the
 * reservation and Mastra's `finishReason`), read by three consumers that
 * cannot see the reservation: the delegation hook (`onDelegationComplete`,
 * which appends the truncation note to the parent-facing result), the child's
 * terminal mapper (`makeTerminalRunEvent`: a `length` finish here is a
 * truncated COMPLETION) and the stream projection (which turns the transient
 * part below into the persisted `delegation.budget.exhausted` run event).
 *
 * The hook runs in-process at tool completion — before the parent stream
 * consumer may have mapped the child's parts — so it MUST read this registry,
 * never the projected stream. One registry per runtime (`DelegatedExecutionOptions`),
 * keyed by native child thread id; a later synthesis on the same thread
 * (a continuation) overwrites. Entries are never deleted: two readers race.
 */
export interface DelegatedSynthesisOutcome {
  /** Which durable cap forced the reserved summary. */
  readonly cap: DelegationBudgetCap;
  /** The cap's ceiling in its own unit (steps, or output tokens). */
  readonly limit: number;
  /** Provider-reported output tokens of the summary; undefined when unknown. */
  readonly outputTokens: number | undefined;
  readonly reservedOutputTokens: number;
  /** The provider cut the summary at the reservation (`finishReason: 'length'`). */
  readonly truncated: boolean;
  /** How much of `limit` the child had used when the summary was forced. */
  readonly used: number;
}

export interface DelegatedSynthesisOutcomes {
  read(childThreadId: string): DelegatedSynthesisOutcome | undefined;
  record(childThreadId: string, outcome: DelegatedSynthesisOutcome): void;
}

export function createDelegatedSynthesisOutcomes(): DelegatedSynthesisOutcomes {
  const outcomes = new Map<string, DelegatedSynthesisOutcome>();
  return {
    read: (childThreadId) => outcomes.get(childThreadId),
    record: (childThreadId, outcome) => {
      outcomes.set(childThreadId, outcome);
    },
  };
}

export const DELEGATED_SYNTHESIS_PART = 'data-brainstrike-delegated-synthesis';

const synthesisPartSchema = z.strictObject({
  cap: z.enum(['steps', 'child-output', 'tree-output']),
  limit: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative().optional(),
  reservedOutputTokens: z.number().int().positive(),
  resourceId: z.string().min(1),
  threadId: z.string().min(1),
  truncated: z.boolean(),
  used: z.number().int().nonnegative(),
});

export type DelegatedSynthesisPart = z.infer<typeof synthesisPartSchema>;

export function readDelegatedSynthesisPart(part: unknown): DelegatedSynthesisPart | undefined {
  return readMastraStreamPartString(part, 'type') === DELEGATED_SYNTHESIS_PART
    ? synthesisPartSchema.parse(readMastraStreamPartValue(part, 'data'))
    : undefined;
}

/** The note appended to a truncated child's answer for the PARENT model. */
export function describeTruncatedSynthesis(
  personaId: string,
  outcome: DelegatedSynthesisOutcome
): string {
  const cap =
    outcome.cap === 'steps'
      ? 'its step budget'
      : outcome.cap === 'child-output'
        ? 'its output token budget'
        : "the turn's shared output token budget";
  const overage =
    outcome.outputTokens !== undefined && outcome.outputTokens > outcome.reservedOutputTokens
      ? ` The provider reported ${outcome.outputTokens} total output tokens, exceeding the ${outcome.reservedOutputTokens}-token reservation. All reported tokens remain charged; no further child work is allowed.`
      : '';
  return (
    `\n\n[Truncated summary] The ${personaId} subagent exhausted ${cap} and its final summary ` +
    `was cut by the model at the ${outcome.reservedOutputTokens}-token synthesis reservation.` +
    overage +
    ' Treat the text above as partial findings from the files it actually read; do not re-run ' +
    'this delegation.'
  );
}
