import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';
import {
  createFixtureCapableAdapter,
  type FixtureControls,
  isFixtureCapableAdapter,
} from '../dev-fixture-adapter';
import type { FixtureDefinition } from '../dev-fixture-types';
import type {
  DirectoryHandle,
  DirectoryStreamCallback,
  FileHandle,
  FileSystemAdapter,
} from '../types';

interface AdapterOptions {
  includeRestoreLastFolder?: boolean;
  includeStreaming?: boolean;
}

const FIXTURE: FixtureDefinition = {
  name: 'fixture-root',
  tree: {
    'README.md': '# fixture',
    src: {
      'a.ts': 'export const a = 1;',
      nested: {
        'z.ts': 'export const z = 26;',
      },
    },
  },
};

const NULL_SHORTHAND_FIXTURE: FixtureDefinition = {
  name: 'null-root',
  tree: {
    'example.ts': null,
  },
};

function createBaseAdapter(options: AdapterOptions = {}): FileSystemAdapter {
  const includeRestoreLastFolder = options.includeRestoreLastFolder ?? true;
  const includeStreaming = options.includeStreaming ?? true;
  const realRoot: DirectoryHandle = {
    kind: 'directory',
    name: 'real-root',
    path: '/real-root',
    platform: 'electron',
  };
  const restoredRoot: DirectoryHandle = {
    kind: 'directory',
    name: 'restored',
    path: '/restored',
    platform: 'electron',
  };

  const adapter: FileSystemAdapter = {
    exists: vi.fn(async (path: string) => path === '/real-root'),
    readDirectory: vi.fn(async () => []),
    readFile: vi.fn(async (_handle: FileHandle) => 'real-file'),
    requestDirectoryAccess: vi.fn(async () => realRoot),
  };

  if (includeStreaming) {
    adapter.readDirectoryStreaming = vi.fn(async () => {
      throw new Error('readDirectoryStreaming should not be called when fixture is active');
    });
  }

  if (includeRestoreLastFolder) {
    adapter.restoreLastFolder = vi.fn(async () => restoredRoot);
  }

  return adapter;
}

describe('createFixtureCapableAdapter (inline fixture)', () => {
  it('is fixture-capable after decoration and not before', () => {
    const base = createBaseAdapter();
    expect(isFixtureCapableAdapter(base)).toBe(false);

    const adapter = createFixtureCapableAdapter(base, { platform: 'web' });
    expect(isFixtureCapableAdapter(adapter)).toBe(true);
    expect(adapter.canLoadInlineFixture).toBe(true);
  });

  it('streams fixture entries via readDirectoryStreaming when active', async () => {
    const base = createBaseAdapter();
    const baseReadDirectoryStreaming = base.readDirectoryStreaming as unknown as ReturnType<
      typeof vi.fn
    >;
    const adapter = createFixtureCapableAdapter(base, { platform: 'web' });

    const rootHandle = await adapter.loadInlineFixture(FIXTURE);

    const batches: Array<{ nodes: IFileNode[]; done: boolean; total: number }> = [];
    const onBatch: DirectoryStreamCallback = (nodes, meta) => {
      batches.push({ done: meta.done, nodes, total: meta.total });
    };

    await adapter.readDirectoryStreaming?.(rootHandle, onBatch, { batchSize: 2 });

    // fixture root contains src/ and README.md
    const final = batches.at(-1);
    expect(final).toBeTruthy();
    expect(final?.done).toBe(true);
    expect(final?.total).toBe(2);

    // batchSize=2 should emit an intermediate batch before completion.
    expect(batches.some((b) => b.done === false)).toBe(true);

    // Ensure base adapter streaming was not invoked while fixture is active
    expect(baseReadDirectoryStreaming).not.toHaveBeenCalled();
  });

  it('delegates readDirectoryStreaming to the base adapter when fixture is not active', async () => {
    const base = createBaseAdapter();
    const baseReadDirectoryStreaming = base.readDirectoryStreaming as unknown as ReturnType<
      typeof vi.fn
    >;
    const adapter = createFixtureCapableAdapter(base, { platform: 'web' });

    const handle: DirectoryHandle = {
      _internal: {} as unknown,
      kind: 'directory',
      name: 'root',
      path: 'root',
      platform: 'web',
    };

    const onBatch: DirectoryStreamCallback = () => {};

    await expect(
      adapter.readDirectoryStreaming?.(handle, onBatch, { batchSize: 1 })
    ).rejects.toThrow('readDirectoryStreaming should not be called when fixture is active');
    expect(baseReadDirectoryStreaming).toHaveBeenCalled();
  });

  it('exposes fixture-backed readDirectory/readFile/exists and resets after clearInlineFixture', async () => {
    const base = createBaseAdapter();
    const baseReadDirectory = base.readDirectory as unknown as ReturnType<typeof vi.fn>;
    const baseReadFile = base.readFile as unknown as ReturnType<typeof vi.fn>;
    const baseExists = base.exists as unknown as ReturnType<typeof vi.fn>;
    const adapter = createFixtureCapableAdapter(base, { platform: 'web' });

    const rootHandle = await adapter.loadInlineFixture(FIXTURE);
    expect(adapter.isInlineFixtureActive()).toBe(true);

    const rootEntries = await adapter.readDirectory(rootHandle);
    expect(rootEntries.map((entry) => `${entry.type}:${entry.name}`)).toEqual([
      'directory:src',
      'file:README.md',
    ]);
    expect(baseReadDirectory).not.toHaveBeenCalled();

    const srcHandle: DirectoryHandle = {
      kind: 'directory',
      name: 'src',
      path: 'fixture-root/src',
      platform: 'web',
    };
    const srcEntries = await adapter.readDirectory(srcHandle);
    expect(srcEntries.map((entry) => entry.name)).toEqual(['nested', 'a.ts']);

    // readDirectory returns clones, so mutating one call does not affect subsequent calls
    const firstSrcEntry = srcEntries[0];
    if (!firstSrcEntry) {
      throw new Error('Expected fixture src directory to include at least one entry');
    }
    firstSrcEntry.name = 'mutated';
    const srcEntriesAgain = await adapter.readDirectory(srcHandle);
    expect(srcEntriesAgain[0]?.name).toBe('nested');

    const fileHandle: FileHandle = {
      kind: 'file',
      name: 'README.md',
      path: 'fixture-root/README.md',
      platform: 'web',
      size: 0,
    };
    await expect(adapter.readFile(fileHandle)).resolves.toBe('# fixture');
    await expect(
      adapter.readFile({
        ...fileHandle,
        name: 'missing.txt',
        path: 'missing.txt',
      })
    ).resolves.toBe('');
    expect(baseReadFile).not.toHaveBeenCalled();

    await expect(adapter.exists('fixture-root/src')).resolves.toBe(true);
    await expect(adapter.exists('fixture-root/src/a.ts')).resolves.toBe(true);
    await expect(adapter.exists('not-in-fixture')).resolves.toBe(false);
    expect(baseExists).toHaveBeenCalledWith('not-in-fixture');

    await adapter.clearInlineFixture();
    expect(adapter.isInlineFixtureActive()).toBe(false);

    await adapter.readDirectory(rootHandle);
    expect(baseReadDirectory).toHaveBeenCalled();
    await adapter.readFile(fileHandle);
    expect(baseReadFile).toHaveBeenCalled();
  });

  it('supports delayed fixture directory reads for browser-driven E2E flows', async () => {
    const adapter = createFixtureCapableAdapter(createBaseAdapter(), { platform: 'web' });
    await adapter.loadInlineFixture(FIXTURE);
    adapter.setInlineFixtureOptions?.({ directoryReadDelayMs: 25 });

    vi.useFakeTimers();
    const readPromise = adapter.readDirectory({
      kind: 'directory',
      name: 'src',
      path: 'fixture-root/src',
      platform: 'web',
    });

    let settled = false;
    void readPromise.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(24);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const entries = await readPromise;
    vi.useRealTimers();

    expect(entries.map((entry) => entry.name)).toEqual(['nested', 'a.ts']);
  });

  it('reads fixture files by path when the wrapped adapter supports direct path reads', async () => {
    const base = createBaseAdapter() as ReturnType<typeof createBaseAdapter> & {
      readFileByPath: ReturnType<typeof vi.fn>;
    };
    base.readFileByPath = vi.fn(async (path: string) => `base:${path}`);

    const adapter = createFixtureCapableAdapter(base, {
      platform: 'web',
    }) as FileSystemAdapter &
      FixtureControls & {
        readFileByPath: (path: string) => Promise<string>;
      };
    await adapter.loadInlineFixture(FIXTURE);

    await expect(adapter.readFileByPath('fixture-root/README.md')).resolves.toBe('# fixture');

    await adapter.clearInlineFixture();
    await expect(adapter.readFileByPath('outside.txt')).resolves.toBe('base:outside.txt');
  });

  it('resolves fixture files for indexing through the stamped rootId alias', async () => {
    const adapter = createFixtureCapableAdapter(createBaseAdapter(), {
      platform: 'web',
    });
    const root = await adapter.loadInlineFixture(FIXTURE);

    if (!root.rootId) {
      throw new Error('Expected fixture root to be stamped with a rootId');
    }

    await expect(adapter.resolveFileForIndexing?.(`${root.rootId}/src/a.ts`)).resolves.toEqual({
      content: 'export const a = 1;',
      fileSize: 'export const a = 1;'.length,
      kind: 'content',
    });
    await expect(
      adapter.resolveFileForIndexing?.(`${root.rootId}/${root.path}/src/a.ts`)
    ).resolves.toEqual({
      content: 'export const a = 1;',
      fileSize: 'export const a = 1;'.length,
      kind: 'content',
    });
  });

  it('streams fixture directories through the stamped rootId alias', async () => {
    const adapter = createFixtureCapableAdapter(createBaseAdapter(), {
      platform: 'web',
    });
    const root = await adapter.loadInlineFixture(FIXTURE);

    if (!root.rootId) {
      throw new Error('Expected fixture root to be stamped with a rootId');
    }

    const streamed: IFileNode[] = [];
    await adapter.readDirectoryStreaming?.(
      {
        kind: 'directory',
        name: 'src',
        path: `${root.rootId}/src`,
        platform: 'web',
      },
      (nodes) => {
        streamed.push(...nodes);
      }
    );

    expect(streamed.map((node) => node.path)).toEqual([
      'fixture-root/src/nested',
      'fixture-root/src/a.ts',
    ]);
  });

  it('treats null file leaves as fixture files with stable default content', async () => {
    const adapter = createFixtureCapableAdapter(createBaseAdapter(), { platform: 'web' });
    await adapter.loadInlineFixture(NULL_SHORTHAND_FIXTURE);

    const entries = await adapter.readDirectory({
      kind: 'directory',
      name: 'null-root',
      path: 'null-root',
      platform: 'web',
    });
    expect(entries.map((entry) => `${entry.type}:${entry.name}`)).toEqual(['file:example.ts']);

    await expect(
      adapter.readFile({
        kind: 'file',
        name: 'example.ts',
        path: 'null-root/example.ts',
        platform: 'web',
        size: 0,
      })
    ).resolves.toBe('example.ts content');
  });

  it('returns empty directory listings for unknown fixture paths and can short-circuit streaming when aborted', async () => {
    const adapter = createFixtureCapableAdapter(createBaseAdapter(), { platform: 'web' });
    await adapter.loadInlineFixture(FIXTURE);

    const unknownDir: DirectoryHandle = {
      kind: 'directory',
      name: 'missing-dir',
      path: 'missing-dir',
      platform: 'web',
    };
    await expect(adapter.readDirectory(unknownDir)).resolves.toEqual([]);

    const abortedController = new AbortController();
    abortedController.abort();
    const streamed: Array<{ done: boolean; total: number }> = [];
    await adapter.readDirectoryStreaming?.(
      {
        kind: 'directory',
        name: 'src',
        path: 'fixture-root/src',
        platform: 'web',
      },
      (_nodes, meta) => {
        streamed.push({ done: meta.done, total: meta.total });
      },
      { batchSize: 1, signal: abortedController.signal }
    );
    expect(streamed).toEqual([{ done: true, total: 0 }]);
  });

  it('restores folders from fixture when active and delegates when inactive', async () => {
    const base = createBaseAdapter({ includeRestoreLastFolder: true });
    const baseRestore = base.restoreLastFolder as unknown as ReturnType<typeof vi.fn>;
    const adapter = createFixtureCapableAdapter(base, { platform: 'electron' });

    const root = await adapter.loadInlineFixture(FIXTURE);
    await expect(adapter.restoreLastFolder?.()).resolves.toEqual(root);

    await adapter.clearInlineFixture();
    await expect(adapter.restoreLastFolder?.()).resolves.toEqual({
      kind: 'directory',
      name: 'restored',
      path: '/restored',
      platform: 'electron',
    });
    expect(baseRestore).toHaveBeenCalledTimes(1);
  });

  it('keeps the same rootId when reloading the same fixture root name', async () => {
    const adapter = createFixtureCapableAdapter(createBaseAdapter(), { platform: 'web' });

    const first = await adapter.loadInlineFixture(FIXTURE);
    const reloaded = await adapter.loadInlineFixture({
      name: FIXTURE.name,
      tree: {
        'new-file.ts': 'export const refreshed = true;',
      },
    });
    const other = await adapter.loadInlineFixture({
      name: 'other-root',
      tree: {
        'new-file.ts': 'export const other = true;',
      },
    });

    expect(reloaded.rootId).toBe(first.rootId);
    expect(other.rootId).not.toBe(first.rootId);
  });

  it('does not add streaming API when base adapter has no streaming support', async () => {
    const base = createBaseAdapter({ includeStreaming: false });
    const adapter = createFixtureCapableAdapter(base, { platform: 'web' });
    expect(adapter.readDirectoryStreaming).toBeUndefined();
  });

  it('forwards getHandleCache when present on the base adapter', () => {
    const base = createBaseAdapter() as FileSystemAdapter & { getHandleCache?: () => string };
    const getHandleCache = vi.fn(() => 'cache');
    base.getHandleCache = getHandleCache;

    const adapter = createFixtureCapableAdapter(base, { platform: 'web' }) as FileSystemAdapter &
      FixtureControls & { getHandleCache?: () => string };

    expect(adapter.getHandleCache?.()).toBe('cache');
    expect(getHandleCache).toHaveBeenCalledTimes(1);
  });
});
