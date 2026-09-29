import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import {
  deriveAssistantRunEventRows,
  resolveAssistantRunEventRenderPlan,
} from '../assistant-run-event-derivation';

/**
 * `delegation.ledger` (settled 2026-09-15) is a SELF-SUPERSEDING row: the
 * host publishes a fresh row for the same `metadata.ledgerId` on every
 * background task lifecycle change, and the timeline shows only the newest.
 * Lives in its own file: assistant-run-timeline.test.tsx sits at Biome's
 * 1000-line cap.
 */
function runEventPart(event: Record<string, unknown>) {
  return { data: event, name: ASSISTANT_RUN_EVENT_DATA_NAME };
}

const ledgerRow = (id: string, running: number, returned: number) => ({
  id,
  kind: 'delegation.ledger',
  label: `${returned} of 4 specialists returned${running > 0 ? ` · ${running} running` : ''}`,
  metadata: { cancelled: 0, failed: 0, ledgerId: 'root-run', returned, running, total: 4 },
  status: running > 0 ? 'running' : 'completed',
  timestamp: '2026-09-15T00:00:00.000Z',
});

const message = (parts: unknown[]) => ({
  content: parts,
  id: 'assistant-1',
  role: 'assistant',
  status: { reason: 'stop', type: 'complete' },
});

describe('delegation.ledger — the latest row of a ledger wins', () => {
  it('hides every earlier row of the same ledger and shows the last (per-event path)', () => {
    const first = ledgerRow('l1', 2, 2);
    const second = ledgerRow('l2', 1, 3);
    const last = ledgerRow('l3', 0, 4);
    const messages = [message([runEventPart(first), runEventPart(second), runEventPart(last)])];
    expect(resolveAssistantRunEventRenderPlan(messages, first)).toEqual({
      hidden: true,
      repeatCount: 1,
    });
    expect(resolveAssistantRunEventRenderPlan(messages, second)).toEqual({
      hidden: true,
      repeatCount: 1,
    });
    expect(resolveAssistantRunEventRenderPlan(messages, last)).toEqual({
      hidden: false,
      repeatCount: 1,
    });
  });

  it('hides every earlier row of the same ledger and shows the last (batched derivation)', () => {
    // MUTATION: scoping the supersede rule on kind alone (ignoring
    // `ledgerId`) hides a DIFFERENT run's final row — the second assertion.
    const first = ledgerRow('l1', 1, 3);
    const last = ledgerRow('l2', 0, 4);
    const otherRun = {
      ...ledgerRow('o1', 0, 4),
      metadata: { ...ledgerRow('o1', 0, 4).metadata, ledgerId: 'other-run' },
    };
    const rows = deriveAssistantRunEventRows([
      message([runEventPart(otherRun), runEventPart(first), runEventPart(last)]),
    ]);
    expect(rows.renderPlanKeys).toEqual({ l1: 'hidden', l2: 'visible:1', o1: 'visible:1' });
    expect(rows.statuses['l2']).toBe('completed');
  });

  it('a later row in a LATER message supersedes too (the resume leg after a parked root)', () => {
    const stale = ledgerRow('l1', 2, 2);
    const fresh = ledgerRow('l2', 0, 4);
    const messages = [message([runEventPart(stale)]), message([runEventPart(fresh)])];
    expect(resolveAssistantRunEventRenderPlan(messages, stale).hidden).toBe(true);
    expect(resolveAssistantRunEventRenderPlan(messages, fresh).hidden).toBe(false);
  });

  it('supersedes across host runs on reload: the ledger id is the identity, never the run', () => {
    // Live run-event parts carry no `runId`; HYDRATED parts carry the persisted
    // one, and the initial leg and the resume leg are different host runs.
    // MUTATION: a run-scoped indexed lookup (`byKindRunAndScope` only) keeps
    // the stale "2 of 4 · 2 running" row visible on the batched path while
    // the per-event path hides it — the two paths must agree.
    const stale = { ...ledgerRow('l1', 2, 2), runId: 'host-leg' };
    const fresh = { ...ledgerRow('l2', 0, 4), runId: 'resume-host-1' };
    const messages = [message([runEventPart(stale)]), message([runEventPart(fresh)])];
    const rows = deriveAssistantRunEventRows(messages);
    expect(rows.renderPlanKeys).toEqual({ l1: 'hidden', l2: 'visible:1' });
    expect(resolveAssistantRunEventRenderPlan(messages, stale).hidden).toBe(true);
  });
});
