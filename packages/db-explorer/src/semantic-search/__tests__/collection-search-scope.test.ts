import { describe, expect, it } from 'vitest';
import { resolveCollectionSearchScope } from '../index';

describe('resolveCollectionSearchScope', () => {
  it('prefers a selection snapshot id over file paths', () => {
    expect(
      resolveCollectionSearchScope({
        distanceMetric: 'cosine',
        filePaths: ['/workspace/src/a.ts'],
        resultLimit: 10,
        retrievalMode: 'hybrid',
        selectionSnapshotId: 'snapshot-1',
        threshold: 0.5,
      })
    ).toEqual({ selectionSnapshotId: 'snapshot-1' });
  });

  it('returns a cloned file path scope when no snapshot id exists', () => {
    const filePaths = ['/workspace/src/a.ts', '/workspace/src/b.ts'];
    const scope = resolveCollectionSearchScope({
      distanceMetric: 'cosine',
      filePaths,
      resultLimit: 10,
      retrievalMode: 'hybrid',
      threshold: 0.5,
    });

    expect(scope).toEqual({ filePaths });
    expect(scope.filePaths).not.toBe(filePaths);
  });

  it('returns an empty scope when the search config has no explicit scope', () => {
    expect(
      resolveCollectionSearchScope({
        distanceMetric: 'cosine',
        resultLimit: 10,
        retrievalMode: 'hybrid',
        threshold: 0.5,
      })
    ).toEqual({});
  });
});
