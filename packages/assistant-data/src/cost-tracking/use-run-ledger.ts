import { useMemo } from 'react';
import { hasDurableAssistantUsageCapability } from '../assistant-durable-usage-capability';
import type { RunLedgerRow } from '../assistant-memory-repository';

/** Newest-first host runs shown by the Task Ledger panel. */
export const TASK_LEDGER_RUN_LIMIT = 50;

export interface RunLedgerState {
  readonly available: boolean;
  readonly rows: readonly RunLedgerRow[];
}

const NO_HOST_RUNS: readonly RunLedgerRow[] = [];

/** The agent host is the sole desktop run authority. Web retains its own run store. */
export function useRunLedger(hostRuns: readonly RunLedgerRow[] = NO_HOST_RUNS): RunLedgerState {
  const available = hasDurableAssistantUsageCapability();
  const rows = useMemo(
    () =>
      available
        ? [...hostRuns]
            .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())
            .slice(0, TASK_LEDGER_RUN_LIMIT)
        : NO_HOST_RUNS,
    [available, hostRuns]
  );
  return { available, rows };
}
