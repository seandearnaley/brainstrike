// @vitest-environment node
import type { IndexerPort, ScopedIndexerPort } from '@brainstrike/indexer';
import { expect, it, onTestFinished, vi } from 'vitest';
import {
  createNativeRootDataDeletion,
  type RootDataDeletionReservation,
} from '../native-root-data-deletion';

function fixture() {
  const events: string[] = [];
  let current = true;
  const ack = Promise.withResolvers<boolean>();
  const removeScopedFile = vi.fn(async (_identity: unknown) => {
    events.push('native-remove');
    return ack.promise;
  });
  const port = { removeScopedFile } as unknown as IndexerPort & ScopedIndexerPort;
  const authority = {
    fileBindings: [
      {
        embeddingSetId: 'collection',
        fileId: 'owned',
        profile: null,
        relativePath: 'owned.ts',
        rootId: 'root',
        sourcePath: '/owned/owned.ts',
      },
      {
        embeddingSetId: 'collection',
        fileId: 'retained',
        profile: null,
        relativePath: null,
        rootId: null,
        sourcePath: null,
      },
      {
        embeddingSetId: 'other-collection',
        fileId: 'foreign',
        profile: null,
        relativePath: 'foreign.ts',
        rootId: 'other',
        sourcePath: '/other/foreign.ts',
      },
    ],
    rootIds: ['root', 'other'],
    scopes: [
      { kind: 'workspace' as const, rootId: 'root' },
      { embeddingSetId: 'collection', kind: 'collection' as const },
    ],
  };
  const assertCurrent = (): void => {
    if (!current) {
      throw new Error('Captured root was replaced');
    }
  };
  const reservation: RootDataDeletionReservation = {
    assertCurrent,
    disconnect: vi.fn(async () => {
      assertCurrent();
      events.push('disconnect');
    }),
    mounted: {
      canonicalPath: '/owned',
      presentationPath: '/alias',
      root: {
        canonicalPath: '/owned',
        close: () => undefined,
        listDir: async () => null,
        readFile: async () => ({ status: 'not-found' }),
      },
      rootId: 'root',
    },
    release: vi.fn(() => {
      events.push('release');
    }),
    retireSources: vi.fn(async () => {
      events.push('root-sources-joined');
    }),
    run: async (operation) => {
      assertCurrent();
      await operation();
    },
  };
  const dependencies = {
    acquire: vi.fn(async () => {
      events.push('acquire');
    }),
    captureOwner: vi.fn(async () => ({
      generation: 7,
      port,
      readAuthority: () => {
        assertCurrent();
        return authority;
      },
    })),
    closeOwner: vi.fn(async () => {
      events.push('writer-exited');
    }),
    deleteCanonicalRoot: vi.fn(async () => {
      assertCurrent();
      events.push('pg-cascade');
    }),
    reserveRoot: vi.fn((rootId: string) => {
      if (rootId !== 'root') {
        throw new Error('Root is not mounted');
      }
      return reservation;
    }),
    resume: vi.fn(async () => {
      events.push('resume');
    }),
    stopSources: vi.fn(async () => {
      events.push('sources-readers-inference-joined');
    }),
  };
  return {
    ack,
    authority,
    dependencies,
    events,
    removeScopedFile,
    replace: () => {
      current = false;
    },
    reservation,
    service: createNativeRootDataDeletion(dependencies),
  };
}

it('admits preparation before a held transition while retaining its physical join in FIFO', async () => {
  const f = fixture();
  const held = Promise.withResolvers<void>();
  const physical = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const first = f.service.transition(async () => {
    entered.resolve();
    await held.promise;
  });
  onTestFinished(() => {
    held.resolve();
    physical.resolve();
  });
  await entered.promise;
  const complete = vi.fn(async (prepared: { physical: Promise<void> }) => prepared.physical);
  const next = f.service.prepareTransition(async () => {
    f.events.push('cancel-admitted');
    return { physical: physical.promise };
  }, complete);
  await vi.waitFor(() => expect(f.events).toContain('cancel-admitted'));
  expect(complete).not.toHaveBeenCalled();
  await expect(f.service.deleteRootData('root')).rejects.toThrow('transition already owns');
  held.resolve();
  await first;
  await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
  let settled = false;
  void next.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  physical.resolve();
  await next;
});

it('refuses prepared cancellation before any side effect when root deletion owns admission', async () => {
  const f = fixture();
  const deletion = f.service.deleteRootData('root');
  onTestFinished(async () => {
    f.ack.resolve(true);
    await deletion;
  });
  const prepare = vi.fn(async () => undefined);
  const complete = vi.fn(async () => undefined);
  await expect(f.service.prepareTransition(prepare, complete)).rejects.toThrow(
    'root deletion owns'
  );
  expect(prepare).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
});

it('joins source/read/inference work and held native ACK before PG cascade, then resumes remaining authority', async () => {
  const f = fixture();
  const deletion = f.service.deleteRootData('root');
  await vi.waitFor(() => expect(f.removeScopedFile).toHaveBeenCalledTimes(1));
  expect(f.dependencies.deleteCanonicalRoot).not.toHaveBeenCalled();
  expect(f.events).toEqual([
    'sources-readers-inference-joined',
    'root-sources-joined',
    'native-remove',
  ]);
  f.ack.resolve(true);
  await deletion;
  expect(f.events).toEqual([
    'sources-readers-inference-joined',
    'root-sources-joined',
    'native-remove',
    'writer-exited',
    'pg-cascade',
    'disconnect',
    'release',
    'resume',
    'acquire',
  ]);
  expect(f.removeScopedFile).toHaveBeenCalledWith({
    fileId: 'owned',
    scope: { kind: 'workspace', rootId: 'root' },
  });
});

it('preserves PG on native cleanup failure and retries the same captured owner without re-resolving grants', async () => {
  const f = fixture();
  f.removeScopedFile.mockRejectedValueOnce(new Error('Native cleanup failed'));
  await expect(f.service.deleteRootData('root')).rejects.toThrow('Native cleanup failed');
  expect(f.dependencies.deleteCanonicalRoot).not.toHaveBeenCalled();
  await expect(f.service.transition(async () => undefined)).rejects.toThrow(/deletion/);
  f.ack.resolve(false);
  await f.service.deleteRootData('root');
  expect(f.dependencies.captureOwner).toHaveBeenCalledTimes(1);
  expect(f.dependencies.reserveRoot).toHaveBeenCalledTimes(1);
});

it('preserves PG when physical source or writer retirement fails', async () => {
  const f = fixture();
  f.dependencies.stopSources.mockRejectedValueOnce(new Error('Reader still owns process'));
  await expect(f.service.deleteRootData('root')).rejects.toThrow('Reader still owns process');
  expect(f.dependencies.deleteCanonicalRoot).not.toHaveBeenCalled();
  f.ack.resolve(true);
  f.dependencies.closeOwner.mockRejectedValueOnce(new Error('Writer still owns process'));
  await expect(f.service.deleteRootData('root')).rejects.toThrow('Writer still owns process');
  expect(f.dependencies.deleteCanonicalRoot).not.toHaveBeenCalled();
  await f.service.deleteRootData('root');
  expect(f.removeScopedFile).toHaveBeenCalledTimes(1);
});

it('refuses a replaced original grant while native ACK is held', async () => {
  const f = fixture();
  const deletion = f.service.deleteRootData('root');
  await vi.waitFor(() => expect(f.removeScopedFile).toHaveBeenCalledTimes(1));
  f.replace();
  f.ack.resolve(true);
  await expect(deletion).rejects.toThrow('Captured root was replaced');
  expect(f.dependencies.deleteCanonicalRoot).not.toHaveBeenCalled();
});

it('refuses unowned roots and a different root during failed cleanup', async () => {
  const f = fixture();
  await expect(f.service.deleteRootData('foreign')).rejects.toThrow('Root is not mounted');
  f.dependencies.stopSources.mockRejectedValueOnce(new Error('Cleanup failed'));
  await expect(f.service.deleteRootData('root')).rejects.toThrow('Cleanup failed');
  await expect(f.service.deleteRootData('other')).rejects.toThrow(/original root/);
  expect(f.dependencies.deleteCanonicalRoot).not.toHaveBeenCalled();
});

it('refuses a writer whose acknowledged scope no longer owns the captured root', async () => {
  const f = fixture();
  f.authority.scopes.length = 0;
  await expect(f.service.deleteRootData('root')).rejects.toThrow(/scope/);
  expect(f.dependencies.deleteCanonicalRoot).not.toHaveBeenCalled();
});

it('uses final acknowledged bindings after admitted work joins, including late rooted membership', async () => {
  const f = fixture();
  const original = f.authority.fileBindings[0];
  if (!original) {
    throw new Error('Fixture missing actual binding');
  }
  f.dependencies.stopSources.mockImplementationOnce(async () => {
    f.events.push('sources-readers-inference-joined');
    f.authority.fileBindings.push({ ...original, fileId: 'late-acknowledged-file' });
  });
  f.ack.resolve(true);
  await f.service.deleteRootData('root');
  expect(f.removeScopedFile.mock.calls.map((call) => call[0])).toEqual([
    { fileId: 'owned', scope: { kind: 'workspace', rootId: 'root' } },
    { fileId: 'late-acknowledged-file', scope: { kind: 'workspace', rootId: 'root' } },
  ]);
});
it('refuses a replaced native owner after a held native ACK without cascading PG', async () => {
  const f = fixture();
  let replaced = false;
  f.dependencies.captureOwner.mockResolvedValueOnce({
    generation: 7,
    port: { removeScopedFile: f.removeScopedFile } as unknown as IndexerPort & ScopedIndexerPort,
    readAuthority: () => {
      if (replaced) {
        throw new Error('Original writer replaced');
      }
      return f.authority;
    },
  });
  const deletion = f.service.deleteRootData('root');
  await vi.waitFor(() => expect(f.removeScopedFile).toHaveBeenCalledOnce());
  replaced = true;
  f.ack.resolve(true);
  await expect(deletion).rejects.toThrow('Original writer replaced');
  expect(f.dependencies.deleteCanonicalRoot).not.toHaveBeenCalled();
});
it('retries failed reacquisition without repeating a completed cascade or resume', async () => {
  const f = fixture();
  f.ack.resolve(true);
  f.dependencies.acquire.mockRejectedValueOnce(new Error('Reopen failed'));
  await expect(f.service.deleteRootData('root')).rejects.toThrow('Reopen failed');
  await f.service.deleteRootData('root');
  expect(f.dependencies.resume).toHaveBeenCalledOnce();
  expect(f.dependencies.deleteCanonicalRoot).toHaveBeenCalledOnce();
  expect(f.reservation.release).toHaveBeenCalledOnce();
});

it('refuses deletion during an already-admitted native transition without reserving its roots', async () => {
  const f = fixture();
  const held = Promise.withResolvers<void>();
  const transition = f.service.transition(() => held.promise);
  await expect(f.service.deleteRootData('root')).rejects.toThrow('already owns admission');
  expect(f.dependencies.reserveRoot).not.toHaveBeenCalled();
  held.resolve();
  await transition;
  f.ack.resolve(true);
  await f.service.deleteRootData('root');
});
it('releases a reservation when capture refuses before any source/native cleanup starts', async () => {
  const f = fixture();
  f.dependencies.captureOwner.mockRejectedValueOnce(new Error('Original owner unavailable'));
  await expect(f.service.deleteRootData('root')).rejects.toThrow('Original owner unavailable');
  expect(f.reservation.release).toHaveBeenCalledOnce();
  expect(f.dependencies.stopSources).not.toHaveBeenCalled();
  expect(f.dependencies.deleteCanonicalRoot).not.toHaveBeenCalled();
  await expect(f.service.transition(async () => undefined)).resolves.toBeUndefined();
});
