/**
 * A live run's hard spend cap (docs/agents/agent-evals.md). It reads only what
 * the host's own ledger measured for each thread (`EvalThreadSpend`, the cost
 * the results print) and is checked between the runner's units: before a
 * thread's next turn and before the next trial or task. A request in flight is
 * never interrupted for cost, so the cap bounds what starts, not the exact
 * total. Spend the ledger cannot price is unknown, and unknown spend under a
 * hard cap stops the run.
 */
import type { EvalThreadSpend } from './scoring.ts';

/** What a batch has spent so far: a measured sum, or why it is unknown. */
export type MeasuredSpend = { readonly usd: number } | { readonly unknown: string };

export const NOTHING_SPENT: MeasuredSpend = { usd: 0 };

export function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

/**
 * `spent` plus one thread's ledger, `label` naming the thread. Unknown once a
 * thread has a call the provider billed but never reported, a call with no
 * list price, or no ledger read at all.
 */
export function addThreadSpend(
  spent: MeasuredSpend,
  thread: Pick<EvalThreadSpend, 'costUsd' | 'unreportedCalls'> | null | undefined,
  label: string
): MeasuredSpend {
  if ('unknown' in spent) {
    return spent;
  }
  if (!thread) {
    return { unknown: `${label} left no thread to read its spend from` };
  }
  if (thread.unreportedCalls > 0) {
    return {
      unknown: `${label} has ${thread.unreportedCalls} call(s) the provider bills but never reported`,
    };
  }
  if (thread.costUsd === null) {
    return { unknown: `${label} has a call with no list price` };
  }
  return { usd: spent.usd + thread.costUsd };
}

/** The measured total, or null while it is unknown. */
export function measuredUsd(spent: MeasuredSpend): number | null {
  return 'usd' in spent ? spent.usd : null;
}

/** A cap and the spend measured under it, which may start more work. */
export interface EvalSpendCap {
  readonly capUsd: number;
  readonly spentUsd: number;
}

/** The cap with the measured spend while it is under the cap; else why no more work starts. */
export function spendCapCheck(
  capUsd: number,
  spent: MeasuredSpend
): EvalSpendCap | { readonly capUsd: number; readonly stop: string } {
  if ('unknown' in spent) {
    return { capUsd, stop: `the spend is unknown: ${spent.unknown}` };
  }
  return spent.usd >= capUsd
    ? { capUsd, stop: `${usd(spent.usd)} measured reaches the ${usd(capUsd)} cap` }
    : { capUsd, spentUsd: spent.usd };
}
