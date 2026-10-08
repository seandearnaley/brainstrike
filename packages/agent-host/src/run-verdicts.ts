import type { HostEvent, HostLogRow, HostParams } from './protocol.js';

type VerdictEvent = Extract<HostEvent, { type: 'run.verdict' }>;

/** The run's effective label, with its committed row address and time. */
export interface HostRunVerdict {
  readonly detail?: string;
  readonly seq: number;
  readonly source: VerdictEvent['source'];
  readonly ts?: number;
  readonly verdict: VerdictEvent['verdict'];
}

/**
 * One label per run: a later verdict replaces an earlier one, except that a
 * derived verdict (hook, edit_revert) never replaces an explicit user verdict.
 * The same precedence the Task Ledger applies to brainstrike_assistant_run_outcomes.
 */
export function projectRunVerdicts(rows: readonly HostLogRow[]): Map<string, HostRunVerdict> {
  const verdicts = new Map<string, HostRunVerdict>();
  for (const row of rows) {
    if (row.event.type !== 'run.verdict') {
      continue;
    }
    const { detail, runId, source, verdict } = row.event;
    if (source !== 'user' && verdicts.get(runId)?.source === 'user') {
      continue;
    }
    verdicts.set(runId, {
      ...(detail === undefined ? {} : { detail }),
      seq: row.seq,
      source,
      ...(row.ts === undefined ? {} : { ts: row.ts }),
      verdict,
    });
  }
  return verdicts;
}

/** A client verdict names a run this thread committed; it is accepted as a user label. */
export function userRunVerdict(
  runThread: string | undefined,
  params: HostParams<'run/verdict'>
): VerdictEvent {
  if (runThread !== params.threadId) {
    throw new Error('Unknown run');
  }
  return {
    ...(params.detail === undefined ? {} : { detail: params.detail }),
    runId: params.runId,
    source: params.source,
    type: 'run.verdict',
    verdict: params.verdict,
  };
}
