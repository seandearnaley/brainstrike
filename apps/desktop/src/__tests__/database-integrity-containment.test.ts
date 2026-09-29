import { describe, expect, it, vi } from 'vitest';
import { startDatabaseIntegrityContainment } from '../database-integrity-containment';
import { createDesktopDatabaseIntegrity } from '../database-integrity-state';

const SIGNAL = { message: 'invalid page in block 3', sqlstate: 'XX001' } as const;

function createFixture() {
  const integrity = createDesktopDatabaseIntegrity({
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    now: () => new Date('2026-09-29T12:00:00.000Z'),
  });
  const cancelAllDesktopEmbeddingBackfills = vi.fn();
  const stop = startDatabaseIntegrityContainment({ cancelAllDesktopEmbeddingBackfills, integrity });
  return { cancelAllDesktopEmbeddingBackfills, integrity, stop };
}

describe('startDatabaseIntegrityContainment', () => {
  it('does nothing while the database is healthy', () => {
    const { cancelAllDesktopEmbeddingBackfills } = createFixture();
    expect(cancelAllDesktopEmbeddingBackfills).not.toHaveBeenCalled();
  });

  it('cancels in-flight backfills exactly once when containment starts', () => {
    const { cancelAllDesktopEmbeddingBackfills, integrity } = createFixture();

    integrity.contain('db:query', SIGNAL);

    expect(cancelAllDesktopEmbeddingBackfills).toHaveBeenCalledTimes(1);
  });

  it('does not cancel again for later errors observed while contained', () => {
    const { cancelAllDesktopEmbeddingBackfills, integrity } = createFixture();
    integrity.contain('db:query', SIGNAL);

    integrity.contain('maintenance', { message: 'again', sqlstate: 'XX002' });

    expect(cancelAllDesktopEmbeddingBackfills).toHaveBeenCalledTimes(1);
  });

  it('does not cancel when the database is replaced and containment clears', () => {
    const { cancelAllDesktopEmbeddingBackfills, integrity } = createFixture();
    integrity.contain('db:query', SIGNAL);

    integrity.markDatabaseReplaced('factory-reset');

    expect(cancelAllDesktopEmbeddingBackfills).toHaveBeenCalledTimes(1);
  });

  it('cancels again for a new containment episode after a replacement', () => {
    const { cancelAllDesktopEmbeddingBackfills, integrity } = createFixture();
    integrity.contain('db:query', SIGNAL);
    integrity.markDatabaseReplaced('developer-reset');

    integrity.contain('maintenance', SIGNAL);

    expect(cancelAllDesktopEmbeddingBackfills).toHaveBeenCalledTimes(2);
  });

  it('stops reacting once the returned disposer runs', () => {
    const { cancelAllDesktopEmbeddingBackfills, integrity, stop } = createFixture();
    stop();

    integrity.contain('db:query', SIGNAL);

    expect(cancelAllDesktopEmbeddingBackfills).not.toHaveBeenCalled();
  });
});
