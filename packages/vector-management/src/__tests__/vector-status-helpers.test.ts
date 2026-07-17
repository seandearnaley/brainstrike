import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildBaseLabel,
  formatRelativeTimeFromNow,
  getBackfillAriaLabel,
  getBackfillButtonText,
  getBackfillTooltip,
  truncateLabel,
} from '../vector-status';
import { getBackfillDisabledState } from '../vector-status/backfill-utils';
import { type VectorQueueDatabase, withTransaction } from '../vector-status/vector-queue-service';

describe('vector-status helpers', () => {
  it('withTransaction commits on success and rolls back on error', async () => {
    const calls: string[] = [];
    const db: VectorQueueDatabase = {
      query: async (sql: string) => {
        calls.push(sql);
        return { rows: [] };
      },
    };

    await withTransaction(db, async () => {
      calls.push('BODY');
    });
    expect(calls).toEqual(['BEGIN', 'BODY', 'COMMIT']);

    calls.length = 0;
    await expect(
      withTransaction(db, async () => {
        calls.push('BODY');
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(calls).toEqual(['BEGIN', 'BODY', 'ROLLBACK']);
  });
});

describe('getBackfillDisabledState', () => {
  const baseParams = {
    activeId: 'set-1',
    backfilling: false,
    coverage: { total: 148, withSet: 0 }, // 148 chunks, 0 embedded
    hasDb: true,
    queueCounts: { queued: 0, running: 0 },
  };

  it('disables when no active embedding set selected', () => {
    const result = getBackfillDisabledState({ ...baseParams, activeId: null });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('Select an active embedding set');
  });

  it('disables when database is not ready', () => {
    const result = getBackfillDisabledState({ ...baseParams, hasDb: false });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('Database not ready yet');
  });

  it('disables when backfilling is already in progress', () => {
    const result = getBackfillDisabledState({ ...baseParams, backfilling: true });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('Backfilling in progress');
  });

  it('disables when jobs are currently running', () => {
    const result = getBackfillDisabledState({
      ...baseParams,
      queueCounts: { queued: 0, running: 1 },
    });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('Jobs are queued or running – wait for completion');
  });

  it('disables when jobs are running even with multiple jobs', () => {
    const result = getBackfillDisabledState({
      ...baseParams,
      queueCounts: { queued: 0, running: 5 },
    });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('Jobs are queued or running – wait for completion');
  });

  it('disables when jobs are queued but not yet running', () => {
    const result = getBackfillDisabledState({
      ...baseParams,
      queueCounts: { queued: 3, running: 0 },
    });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('Jobs are queued or running – wait for completion');
  });

  it('disables when jobs are both queued and running', () => {
    const result = getBackfillDisabledState({
      ...baseParams,
      queueCounts: { queued: 5, running: 2 },
    });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('Jobs are queued or running – wait for completion');
  });

  it('disables when all chunks already embedded', () => {
    const result = getBackfillDisabledState({
      ...baseParams,
      coverage: { total: 148, withSet: 148 },
    });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('All chunks already embedded for active set');
  });

  it('enables when all conditions are met and chunks are pending', () => {
    const result = getBackfillDisabledState(baseParams);
    expect(result.disabled).toBe(false);
    expect(result.title).toBe('Enqueue jobs for chunks missing embeddings for the active set');
  });

  it('enables when no chunks exist (empty database)', () => {
    const result = getBackfillDisabledState({
      ...baseParams,
      coverage: { total: 0, withSet: 0 },
    });
    expect(result.disabled).toBe(false);
    expect(result.title).toBe(
      'No pending chunks detected – you can still enqueue a backfill to double-check.'
    );
  });

  it('prioritizes checks in correct order: activeId before running jobs', () => {
    const result = getBackfillDisabledState({
      ...baseParams,
      activeId: null,
      queueCounts: { queued: 0, running: 5 },
    });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('Select an active embedding set');
  });

  it('prioritizes checks in correct order: hasDb before running jobs', () => {
    const result = getBackfillDisabledState({
      ...baseParams,
      hasDb: false,
      queueCounts: { queued: 0, running: 5 },
    });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('Database not ready yet');
  });

  it('prioritizes checks in correct order: backfilling before running jobs', () => {
    const result = getBackfillDisabledState({
      ...baseParams,
      backfilling: true,
      queueCounts: { queued: 0, running: 5 },
    });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('Backfilling in progress');
  });

  it('prioritizes running jobs before coverage complete check', () => {
    const result = getBackfillDisabledState({
      ...baseParams,
      coverage: { total: 148, withSet: 148 },
      queueCounts: { queued: 0, running: 3 },
    });
    expect(result.disabled).toBe(true);
    expect(result.title).toBe('Jobs are queued or running – wait for completion');
  });
});

describe('formatRelativeTimeFromNow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "never" when timestamp missing', () => {
    expect(formatRelativeTimeFromNow(null)).toBe('never');
  });

  it('returns "unknown" for invalid timestamp', () => {
    expect(formatRelativeTimeFromNow('not-a-date')).toBe('unknown');
  });

  it('describes minutes, hours, and days appropriately', () => {
    expect(formatRelativeTimeFromNow('2025-01-01T11:45:00.000Z')).toBe('15m ago');
    expect(formatRelativeTimeFromNow('2025-01-01T10:00:00.000Z')).toBe('2h ago');
    expect(formatRelativeTimeFromNow('2024-12-28T12:00:00.000Z')).toBe('4d ago');
  });
});

describe('truncateLabel', () => {
  it('returns trimmed label when under 24 chars', () => {
    expect(truncateLabel('Short Label')).toBe('Short Label');
    expect(truncateLabel('  padded  ')).toBe('padded');
  });

  it('returns exactly 24 chars without truncation', () => {
    const label24 = '123456789012345678901234';
    expect(truncateLabel(label24)).toBe(label24);
  });

  it('truncates to 21 chars with ellipsis when over 24 chars', () => {
    const longLabel = 'This is a very long label that exceeds 24 characters';
    expect(truncateLabel(longLabel)).toBe('This is a very long l…');
    expect(truncateLabel(longLabel).length).toBe(22); // 21 + ellipsis
  });

  it('handles empty string', () => {
    expect(truncateLabel('')).toBe('');
    expect(truncateLabel('   ')).toBe('');
  });
});

describe('buildBaseLabel', () => {
  it('returns "Backfill" when label is null', () => {
    expect(buildBaseLabel(null)).toBe('Backfill');
  });

  it('returns "Backfill" when label is empty', () => {
    expect(buildBaseLabel('')).toBe('Backfill');
    expect(buildBaseLabel('   ')).toBe('Backfill');
  });

  it('returns "Backfill {label}" for short labels', () => {
    expect(buildBaseLabel('MySet')).toBe('Backfill MySet');
  });

  it('truncates long labels in the base label', () => {
    const longLabel = 'My Very Long Embedding Set Name Here';
    expect(buildBaseLabel(longLabel)).toBe('Backfill My Very Long Embeddin…');
  });
});

describe('getBackfillButtonText', () => {
  const baseLabel = 'Backfill MySet';

  it('returns "Starting…" when worker is starting', () => {
    expect(getBackfillButtonText(baseLabel, true, false, null, false)).toBe('Starting…');
  });

  it('shows progress while backfilling when progress is available', () => {
    expect(getBackfillButtonText(baseLabel, false, true, { done: 5, total: 10 }, false)).toBe(
      '5/10'
    );
  });

  it('returns "Backfilling…" when backfilling without progress', () => {
    expect(getBackfillButtonText(baseLabel, false, true, null, false)).toBe('Backfilling…');
  });

  it('returns "Start & {baseLabel}" when willAutoStartWorker is true', () => {
    expect(getBackfillButtonText(baseLabel, false, false, null, true)).toBe(
      'Start & Backfill MySet'
    );
  });

  it('returns baseLabel in default state', () => {
    expect(getBackfillButtonText(baseLabel, false, false, null, false)).toBe('Backfill MySet');
  });

  it('prioritizes backfilling progress over startingWorker and auto-start', () => {
    expect(getBackfillButtonText(baseLabel, true, true, { done: 5, total: 10 }, true)).toBe('5/10');
  });

  it('prioritizes backfilling progress over willAutoStartWorker', () => {
    expect(getBackfillButtonText(baseLabel, false, true, { done: 3, total: 8 }, true)).toBe('3/8');
  });
});

describe('getBackfillAriaLabel', () => {
  const baseLabel = 'Backfill MySet';
  const activeLabel = 'MySet';

  it('returns "Starting worker…" when worker is starting', () => {
    expect(getBackfillAriaLabel(baseLabel, activeLabel, true, false, false)).toBe(
      'Starting worker…'
    );
  });

  it('returns "Backfilling {label}" when backfilling with active label', () => {
    expect(getBackfillAriaLabel(baseLabel, activeLabel, false, true, false)).toBe(
      'Backfilling MySet'
    );
  });

  it('returns "Backfilling current collection" when backfilling without label', () => {
    expect(getBackfillAriaLabel(baseLabel, null, false, true, false)).toBe(
      'Backfilling current collection'
    );
  });

  it('returns "Start worker and {baseLabel}" when willAutoStartWorker', () => {
    expect(getBackfillAriaLabel(baseLabel, activeLabel, false, false, true)).toBe(
      'Start worker and backfill myset'
    );
  });

  it('returns "Backfill {truncated label}" with active label in default state', () => {
    expect(getBackfillAriaLabel(baseLabel, activeLabel, false, false, false)).toBe(
      'Backfill MySet'
    );
  });

  it('returns "Backfill current collection" without label in default state', () => {
    expect(getBackfillAriaLabel(baseLabel, null, false, false, false)).toBe(
      'Backfill current collection'
    );
  });

  it('truncates long labels in aria label', () => {
    const longLabel = 'My Very Long Embedding Set Name Here';
    expect(getBackfillAriaLabel(baseLabel, longLabel, false, false, false)).toBe(
      'Backfill My Very Long Embeddin…'
    );
  });
});

describe('getBackfillTooltip', () => {
  const baseLabel = 'Backfill MySet';
  const activeLabel = 'MySet';
  const defaultTitle = 'Enqueue jobs for chunks missing embeddings';

  it('returns "Starting embedding worker…" when worker is starting', () => {
    expect(getBackfillTooltip(defaultTitle, baseLabel, activeLabel, true, false)).toBe(
      'Starting embedding worker…'
    );
  });

  it('returns combined action tooltip when willAutoStartWorker', () => {
    expect(getBackfillTooltip(defaultTitle, baseLabel, activeLabel, false, true)).toBe(
      'Start embedding worker and enqueue backfill jobs'
    );
  });

  it('returns defaultTitle when provided and not in special state', () => {
    expect(getBackfillTooltip(defaultTitle, baseLabel, activeLabel, false, false)).toBe(
      'Enqueue jobs for chunks missing embeddings'
    );
  });

  it('returns "Backfill {label}" when no defaultTitle and has activeLabel', () => {
    expect(getBackfillTooltip('', baseLabel, activeLabel, false, false)).toBe('Backfill MySet');
  });

  it('returns "Backfill current collection" when no defaultTitle and no activeLabel', () => {
    expect(getBackfillTooltip('', baseLabel, null, false, false)).toBe(
      'Backfill current collection'
    );
  });

  it('prioritizes startingWorker over willAutoStartWorker', () => {
    expect(getBackfillTooltip(defaultTitle, baseLabel, activeLabel, true, true)).toBe(
      'Starting embedding worker…'
    );
  });
});
