import type { StorageThreadType } from '@mastra/core/memory';
import { describe, expect, it } from 'vitest';
import { resolveThreadSave } from '../thread-title-policy';

const createdAt = new Date('2026-08-01T10:00:00.000Z');
const updatedAt = new Date('2026-08-01T10:01:00.000Z');

function thread(overrides: Partial<StorageThreadType> = {}): StorageThreadType {
  return {
    createdAt,
    id: 'thread-1',
    resourceId: 'resource-1',
    title: 'New Thread',
    updatedAt,
    ...overrides,
  };
}

describe('resolveThreadSave', () => {
  it('marks an inserted placeholder as system-owned', () => {
    const proposed = thread({ metadata: { source: 'seed' } });

    expect(resolveThreadSave(null, proposed)).toEqual({
      effectiveCreatedAt: createdAt,
      effectiveMetadata: { source: 'seed', titleSource: 'om' },
      effectiveTitle: 'New Thread',
      effectiveUpdatedAt: updatedAt,
      preservedGeneratedTitle: false,
      proposedTitle: 'New Thread',
    });
  });

  it('keeps an explicit title insert user-owned', () => {
    const proposed = thread({ metadata: { source: 'import' }, title: 'Imported title' });

    expect(resolveThreadSave(null, proposed)).toMatchObject({
      effectiveMetadata: { source: 'import' },
      effectiveTitle: 'Imported title',
      preservedGeneratedTitle: false,
    });
  });

  it('preserves a user-owned title, metadata, creation time, and newer update time', () => {
    const existing = thread({
      createdAt: new Date('2026-07-31T09:00:00.000Z'),
      metadata: { owner: 'user' },
      title: 'Manual title',
      updatedAt: new Date('2026-08-01T10:02:00.000Z'),
    });
    const proposed = thread({
      createdAt: new Date('2026-08-01T09:00:00.000Z'),
      metadata: { titleSource: 'om' },
      title: 'Late generated title',
      updatedAt,
    });

    expect(resolveThreadSave(existing, proposed)).toEqual({
      effectiveCreatedAt: existing.createdAt,
      effectiveMetadata: { owner: 'user' },
      effectiveTitle: 'Manual title',
      effectiveUpdatedAt: existing.updatedAt,
      preservedGeneratedTitle: true,
      proposedTitle: 'Late generated title',
    });
  });

  it('replaces a generated title and merges metadata while retaining the ownership marker', () => {
    const existing = thread({
      metadata: { old: true, titleSource: 'om' },
      title: 'Old generated title',
    });
    const proposed = thread({
      metadata: { fresh: true },
      title: 'New generated title',
      updatedAt: new Date('2026-08-01T10:03:00.000Z'),
    });

    expect(resolveThreadSave(existing, proposed)).toMatchObject({
      effectiveMetadata: { fresh: true, old: true, titleSource: 'om' },
      effectiveTitle: 'New generated title',
      effectiveUpdatedAt: proposed.updatedAt,
      preservedGeneratedTitle: false,
    });
  });
});
