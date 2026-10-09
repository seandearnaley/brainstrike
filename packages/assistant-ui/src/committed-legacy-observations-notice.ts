import type { AssistantRunEvent } from '@brainstrike/assistant-contract';

/**
 * Gap 17's committed legacy-observations notice as its run's always-visible
 * timeline row. Its key is the committed row's address, never a new identity.
 */
export function legacyObservationsNotice(
  row: { readonly seq: number; readonly threadId: string },
  runId: string,
  timestamp: string
): AssistantRunEvent {
  return {
    detail:
      'Observations recorded before the agent host were not carried over; new ones build up from here.',
    id: `run-event-${row.threadId}-${row.seq}`,
    kind: 'memory.observation.withheld',
    label: 'Earlier observations not imported',
    metadata: { reason: 'legacy-resource-observations' },
    runId,
    status: 'info',
    timestamp,
  };
}
