/**
 * The endpoint-side live decision log (swarm diagnostics, migration 139): an
 * outcome is stored under the host run it addressed; a run that has no row is
 * logged and not stored (ruling 5); a failed write is logged with its own
 * code and never fails the endpoint (ruling 4).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLiveDecisionLog } from '../../assistant-server/live-decision-log';
import { desktopAssistantServerLogger as logger } from '../../assistant-server/logger';

const record = {
  kind: 'approval',
  outcome: 'no-live-run',
  source: 'user',
  toolCallId: 'delegate-1',
} as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createLiveDecisionLog', () => {
  it('stores the outcome under the addressed host run and logs nothing', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({
      rows: [{ id: 'row' }] as unknown[],
    }));
    await createLiveDecisionLog(async () => ({ query }))('leg', record);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(['leg', 'delegate-1', 'approval', 'user', 'no-live-run'])
    );
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('logs a decision for a run that has no row instead of storing it (ruling 5)', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    // MUTATION: treating 'run-missing' as stored drops this warning.
    await createLiveDecisionLog(async () => ({ query: async () => ({ rows: [] }) }))(
      'ghost',
      record
    );
    expect(warn).toHaveBeenCalledWith(
      'Live decision log has no host run',
      expect.objectContaining({
        code: 'live_decision_log_run_missing',
        hostRunId: 'ghost',
        outcome: 'no-live-run',
        toolCallId: 'delegate-1',
      })
    );
  });

  it('logs a failed write with its own code and resolves: a diagnostic never fails the endpoint', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    await expect(
      createLiveDecisionLog(async () => {
        throw new Error('database closed');
      })('leg', record)
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      'Live decision log failed to persist',
      expect.objectContaining({
        code: 'live_decision_log_failed',
        hostRunId: 'leg',
        toolCallId: 'delegate-1',
      })
    );
  });
});
