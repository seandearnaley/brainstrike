import type { RootDescriptor } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import { mapHostRecordedRoots } from '../roots/root-registry';

function pathRoot(rootId: string, name: string, path: string): RootDescriptor {
  return {
    displayName: name,
    handle: { kind: 'directory', name, path, platform: 'electron' },
    kind: 'path',
    permissionState: 'granted',
    persisted: true,
    rootId,
  };
}

describe('mapHostRecordedRoots', () => {
  it('maps host-committed descriptors without a second database lookup (BST-1990)', async () => {
    const result = await mapHostRecordedRoots({
      adapterRoots: [
        pathRoot('first-id', 'first', '/workspace/first'),
        pathRoot('second-id', 'second', '/workspace/second'),
        { ...pathRoot('temporary', 'temporary', '/workspace/temporary'), persisted: false },
        {
          ...pathRoot('unavailable', 'unavailable', '/workspace/unavailable'),
          permissionState: 'unknown',
        },
      ],
    });

    expect([...result.dbRootIdByAdapterRootId]).toEqual([
      ['first-id', 'first-id'],
      ['second-id', 'second-id'],
    ]);
    expect([...result.dbRootKindByAdapterRootId]).toEqual([
      ['first-id', 'path'],
      ['second-id', 'path'],
    ]);
  });
});
