import { describe, expect, it, vi } from 'vitest';
import { createNativeCallerRead } from '../native-caller-query';
import type { NativeSearchAuthority } from '../native-scoped-search';

function fixture() {
  const profile = {
    dimensions: 384,
    distance: 'cosine',
    dtype: 'fp16',
    modelId: 'selected',
    provider: 'local',
    revision: 'revision',
    tokenCap: 256,
  } as const;
  const authority: NativeSearchAuthority = {
    bindings: [
      {
        embeddingSetId: 'collection',
        fileId: 'file',
        profile,
        relativePath: 'source.ts',
        rootId: 'root',
        sourcePath: null,
      },
    ],
    collectionId: 'collection',
    generation: 1,
    profile,
    queryPlan: undefined,
    readiness: [
      { scanComplete: true, scope: { embeddingSetId: 'collection', kind: 'collection' } },
    ],
    rootIds: ['root'],
  };
  const getAuthority = vi.fn(async () => authority);
  const read = { getAuthority, port: { info: async () => ({ storeId: 'a'.repeat(64) }) } };
  return { authority, getAuthority, read };
}

describe('native caller query authority', () => {
  it('holds the read until owned SQL cleanup settles and passes the current full profile', async () => {
    const { authority, read } = fixture();
    const cleanup = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let released = false;
    const caller = createNativeCallerRead(async (work) => {
      try {
        return await work(read);
      } finally {
        released = true;
      }
    });
    const result = caller(async (context) => {
      expect(context).toEqual({
        collectionId: 'collection',
        fileIds: ['file'],
        profile: authority.profile,
        storeId: 'a'.repeat(64),
      });
      entered.resolve();
      await cleanup.promise;
      return 'rows';
    });
    await entered.promise;
    expect(released).toBe(false);
    cleanup.resolve();
    expect(await result).toBe('rows');
    expect(released).toBe(true);
  });
  it.each(['profile', 'scan'] as const)(
    'refuses missing %s authority before SQL admission',
    async (missing) => {
      const { authority, getAuthority, read } = fixture();
      getAuthority.mockResolvedValue({
        ...authority,
        ...(missing === 'profile' ? { profile: null } : { readiness: [] }),
      });
      const work = vi.fn();
      await expect(createNativeCallerRead((run) => run(read))(work)).rejects.toThrow(
        'complete current collection scan'
      );
      expect(work).not.toHaveBeenCalled();
    }
  );
  it('rejects a changed generation after SQL cleanup', async () => {
    const { authority, getAuthority, read } = fixture();
    getAuthority
      .mockResolvedValueOnce(authority)
      .mockResolvedValueOnce({ ...authority, generation: 2 });
    await expect(createNativeCallerRead((run) => run(read))(async () => 'rows')).rejects.toThrow(
      'changed during caller query'
    );
  });
  it('suppresses a late result when Stop arrives during owned SQL cleanup', async () => {
    const { read } = fixture();
    const controller = new AbortController();
    const reason = new Error('Stop');
    await expect(
      createNativeCallerRead((run) => run(read))(async () => {
        controller.abort(reason);
        return 'rows';
      }, controller.signal)
    ).rejects.toBe(reason);
  });
});
