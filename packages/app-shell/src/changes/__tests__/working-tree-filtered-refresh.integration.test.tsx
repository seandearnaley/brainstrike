import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdaptersProvider } from '@brainstrike/file-explorer-hooks';
import {
  FileExplorerProvider,
  useFileExplorerStoreContext,
  useFileSystemInstance,
} from '@brainstrike/file-explorer-ui/shell';
import {
  type DirectoryHandle,
  type FileSystemWatchBatchMetadata,
  type FileSystemWatchSignal,
  MockFileSystemAdapter,
} from '@brainstrike/file-system';
import {
  type ParcelWatcherModule,
  startParcelWatch,
} from '@brainstrike/file-system/testing/parcel-producer';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import type { FileSystemChange, RootDescriptor } from '@brainstrike/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  selectGitScopeRefreshNonce,
  useChangesLiveRefreshStore,
} from '../changes-live-refresh-store';
import { acquireChangesLiveRefreshSubscription } from '../use-changes-live-refresh';

const ROOT_ID = 'bst-1180-filtered-root';

interface ParcelEvent {
  path: string;
  type: 'create' | 'delete' | 'update';
}

class ParcelProducingTestAdapter extends MockFileSystemAdapter {
  readonly #handle: DirectoryHandle;
  #emit: ((events: ParcelEvent[]) => void) | null = null;
  readonly #module: ParcelWatcherModule;
  readonly #ready: Promise<void>;
  #resolveReady: () => void = () => undefined;

  constructor(handle: DirectoryHandle) {
    super();
    this.#handle = handle;
    this.#ready = new Promise((resolve) => {
      this.#resolveReady = resolve;
    });
    this.#module = {
      subscribe: async (_directoryPath, callback) => {
        this.#emit = (events) => callback(null, events);
        return {
          unsubscribe: async () => {
            this.#emit = null;
          },
        };
      },
    } as ParcelWatcherModule;
  }

  async restoreRoots(): Promise<RootDescriptor[]> {
    return [
      {
        displayName: this.#handle.name,
        handle: this.#handle,
        kind: 'path',
        permissionState: 'granted',
        persisted: true,
        rootId: ROOT_ID,
      },
    ];
  }

  watchDirectory(
    handle: DirectoryHandle,
    callback: (changes: FileSystemChange[], metadata?: FileSystemWatchBatchMetadata) => void,
    _onSignal?: (signal: FileSystemWatchSignal) => void
  ): () => void {
    let closed = false;
    let stop: (() => void) | null = null;
    void startParcelWatch(handle, callback, {
      loadModule: () => Promise.resolve(this.#module),
      reportDefaultFilteredChanges: true,
    }).then((nextStop) => {
      this.#resolveReady();
      if (closed) {
        nextStop();
        return;
      }
      stop = nextStop;
    });
    return () => {
      closed = true;
      stop?.();
    };
  }

  emit(events: ParcelEvent[]): void {
    if (!this.#emit) {
      throw new Error('Parcel producer emitted before subscribe completed');
    }
    this.#emit(events);
  }

  async waitUntilReady(): Promise<void> {
    await this.#ready;
  }
}

interface MountedWatcherFixture {
  readonly adapter: ParcelProducingTestAdapter;
  readonly release: () => void;
  readonly root: string;
  readonly store: ReturnType<typeof useFileExplorerStoreContext>;
  readonly unmount: () => void;
}

async function mountWatcherFixture(): Promise<MountedWatcherFixture> {
  const root = await mkdtemp(join(tmpdir(), 'bst-1180-filtered-refresh-'));
  await Promise.all([
    mkdir(join(root, 'dist'), { recursive: true }),
    mkdir(join(root, 'custom-hidden'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, 'dist', 'generated.js'), 'before\n'),
    writeFile(join(root, 'custom-hidden', 'source.ts'), 'before\n'),
  ]);

  const handle: DirectoryHandle = {
    kind: 'directory',
    name: 'filtered-output-fixture',
    path: root,
    platform: 'electron',
    rootId: ROOT_ID,
  };
  const adapter = new ParcelProducingTestAdapter(handle);
  const storage = new MemoryStorageAdapter();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <AdaptersProvider fileSystemAdapter={adapter} storageAdapter={storage}>
      <FileExplorerProvider fileSystemAdapter={adapter} storageAdapter={storage}>
        {children}
      </FileExplorerProvider>
    </AdaptersProvider>
  );
  const rendered = renderHook(
    () => ({
      fileSystem: useFileSystemInstance(),
      store: useFileExplorerStoreContext(),
    }),
    { wrapper: Wrapper }
  );
  await waitFor(() => {
    expect(rendered.result.current.fileSystem.rootDirectoryHandles).toContainEqual(handle);
  });
  await adapter.waitUntilReady();
  const release = acquireChangesLiveRefreshSubscription({
    repositoryRoot: root,
    rootId: ROOT_ID,
    worktreePath: root,
  });

  return {
    adapter,
    release,
    root,
    store: rendered.result.current.store,
    unmount: rendered.unmount,
  };
}

async function disposeWatcherFixture(fixture: MountedWatcherFixture): Promise<void> {
  fixture.release();
  fixture.unmount();
  await rm(fixture.root, { force: true, recursive: true });
}

describe('filtered working-tree evidence (real Parcel producer to Changes consumer)', () => {
  beforeEach(() => {
    useChangesLiveRefreshStore.getState().reset();
  });

  afterEach(() => {
    useChangesLiveRefreshStore.getState().reset();
  });

  it('refreshes a Git scope when a bounded default-filtered output changes', async () => {
    const fixture = await mountWatcherFixture();
    try {
      await appendFile(join(fixture.root, 'dist', 'generated.js'), 'after\n');
      fixture.adapter.emit([{ path: join(fixture.root, 'dist', 'generated.js'), type: 'update' }]);

      await waitFor(
        () => {
          expect(
            selectGitScopeRefreshNonce(useChangesLiveRefreshStore.getState(), fixture.root)
          ).toBe(1);
        },
        { timeout: 5000 }
      );
      expect(useChangesLiveRefreshStore.getState().anyInvalidationNonce).toBe(0);
    } finally {
      await disposeWatcherFixture(fixture);
    }
  });

  it('refreshes a Git scope when a custom display-excluded file changes', async () => {
    const fixture = await mountWatcherFixture();
    try {
      act(() => {
        fixture.store.setState({ excludeFilters: ['custom-hidden/**'] });
      });
      await appendFile(join(fixture.root, 'custom-hidden', 'source.ts'), 'after\n');
      fixture.adapter.emit([
        { path: join(fixture.root, 'custom-hidden', 'source.ts'), type: 'update' },
      ]);

      await waitFor(
        () => {
          expect(
            selectGitScopeRefreshNonce(useChangesLiveRefreshStore.getState(), fixture.root)
          ).toBe(1);
        },
        { timeout: 5000 }
      );
      expect(useChangesLiveRefreshStore.getState().anyInvalidationNonce).toBe(0);
    } finally {
      await disposeWatcherFixture(fixture);
    }
  });
});
