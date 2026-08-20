import type { IFileNode } from '@brainstrike/types';
import { describe, expect, it, vi } from 'vitest';
import {
  createFixtureCapableAdapter,
  type FixtureControls,
  isFixtureCapableAdapter,
} from '../dev-fixture-adapter.js';
import type { FixtureDefinition } from '../dev-fixture-types.js';
import { DEV_INLINE_FIXTURE } from '../fixtures/dev-inline-fixture.js';
import type {
  DirectoryHandle,
  DirectoryStreamCallback,
  FileHandle,
  FileSystemAdapter,
} from '../types.js';

interface AdapterOptions {
  includeRestoreLastFolder?: boolean;
  includeStreaming?: boolean;
  includeWatchDirectory?: boolean;
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

  if (options.includeWatchDirectory) {
    adapter.watchDirectory = vi.fn(() => () => {});
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
        path: 'fixture-root/missing.txt',
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
    // The wrapper only exists when the BASE adapter has the capability (web).
    const base = createBaseAdapter() as ReturnType<typeof createBaseAdapter> & {
      resolveFileForIndexing: ReturnType<typeof vi.fn>;
    };
    base.resolveFileForIndexing = vi.fn(async (path: string) => ({
      content: `base:${path}`,
      fileSize: 0,
      kind: 'content' as const,
    }));
    const adapter = createFixtureCapableAdapter(base, {
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
    // Foreign paths delegate to the base resolver.
    await expect(adapter.resolveFileForIndexing?.('/real/main.ts')).resolves.toEqual({
      content: 'base:/real/main.ts',
      fileSize: 0,
      kind: 'content',
    });
  });

  it('does NOT advertise resolveFileForIndexing when the base adapter lacks it', async () => {
    // Capability rule (mirrors streaming/readFileByPath): consumers feature-
    // detect this method to choose the web resolver over the Electron reader.
    // Advertising it on a capability-less base (desktop) routed REAL files
    // into a resolver that could not serve them while a fixture was active.
    const adapter = createFixtureCapableAdapter(createBaseAdapter(), { platform: 'electron' });
    await adapter.loadInlineFixture(FIXTURE);

    expect(adapter.resolveFileForIndexing).toBeUndefined();
    // Fixture files still readable through the universal readFile path.
    await expect(
      adapter.readFile({
        kind: 'file',
        name: 'a.ts',
        path: 'fixture-root/src/a.ts',
        platform: 'electron',
      })
    ).resolves.toBe('export const a = 1;');
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

  it('returns empty directory listings for fixture-OWNED paths that are missing', async () => {
    const base = createBaseAdapter();
    // The decorator mutates the adapter in place — capture the original spy.
    const baseReadDirectory = base.readDirectory;
    const adapter = createFixtureCapableAdapter(base, { platform: 'web' });
    await adapter.loadInlineFixture(FIXTURE);

    // Under the fixture root but absent from the tree: a fixture-authoring
    // bug, not a real filesystem path — stays fixture-served (empty + warn).
    const missingOwnedDir: DirectoryHandle = {
      kind: 'directory',
      name: 'missing-dir',
      path: 'fixture-root/missing-dir',
      platform: 'web',
    };
    await expect(adapter.readDirectory(missingOwnedDir)).resolves.toEqual([]);
    expect(baseReadDirectory).not.toHaveBeenCalled();
  });

  describe('foreign (non-fixture) paths while a fixture is active', () => {
    // Regression: a persisted dev-fixture flag used to make the adapter claim
    // EVERY path — real workspace roots read as empty ("No files in this
    // folder") with only a console warn. Fixtures own ONLY their subtrees;
    // anything else must delegate to the real adapter.
    const realDir: DirectoryHandle = {
      kind: 'directory',
      name: 'brainstrike',
      path: '/Users/dev/brainstrike',
      platform: 'electron',
    };

    it('delegates readDirectory for a real root outside every fixture root', async () => {
      const base = createBaseAdapter();
      const baseReadDirectory = base.readDirectory as ReturnType<typeof vi.fn>;
      const realNodes = [
        {
          depth: 0,
          isVisible: true,
          name: 'package.json',
          path: '/Users/dev/brainstrike/package.json',
          rootFolderId: 'real',
          selectionState: 'unchecked',
          type: 'file',
        } as unknown as IFileNode,
      ];
      baseReadDirectory.mockResolvedValue(realNodes);
      const adapter = createFixtureCapableAdapter(base, { platform: 'electron' });
      await adapter.loadInlineFixture(FIXTURE);

      await expect(adapter.readDirectory(realDir)).resolves.toEqual(realNodes);
      expect(baseReadDirectory).toHaveBeenCalledTimes(1);
    });

    it('delegates readDirectoryStreaming for a real root outside every fixture root', async () => {
      const base = createBaseAdapter();
      const baseReadDirectoryStreaming = base.readDirectoryStreaming as ReturnType<typeof vi.fn>;
      const streamed: IFileNode[][] = [];
      baseReadDirectoryStreaming.mockImplementation(
        async (_handle: DirectoryHandle, onBatch: DirectoryStreamCallback) => {
          onBatch([], { done: true, total: 0 });
        }
      );
      const adapter = createFixtureCapableAdapter(base, { platform: 'electron' });
      await adapter.loadInlineFixture(FIXTURE);

      await adapter.readDirectoryStreaming?.(realDir, (nodes) => {
        streamed.push(nodes);
      });
      expect(baseReadDirectoryStreaming).toHaveBeenCalledTimes(1);
    });

    it('delegates readFile for a real file outside every fixture root', async () => {
      const base = createBaseAdapter();
      const baseReadFile = base.readFile as ReturnType<typeof vi.fn>;
      const adapter = createFixtureCapableAdapter(base, { platform: 'electron' });
      await adapter.loadInlineFixture(FIXTURE);

      const realFile: FileHandle = {
        kind: 'file',
        name: 'main.ts',
        path: '/Users/dev/brainstrike/main.ts',
        platform: 'electron',
      };
      await expect(adapter.readFile(realFile)).resolves.toBe('real-file');
      expect(baseReadFile).toHaveBeenCalledTimes(1);
    });

    it('keeps active fixture roots inert while delegating real directory watches', async () => {
      const base = createBaseAdapter({ includeWatchDirectory: true });
      const baseWatchDirectory = base.watchDirectory as ReturnType<typeof vi.fn>;
      const baseStop = vi.fn();
      baseWatchDirectory.mockReturnValue(baseStop);
      const adapter = createFixtureCapableAdapter(base, { platform: 'electron' });
      const fixtureRoot = await adapter.loadInlineFixture(FIXTURE);
      const onChanges = vi.fn();
      const onSignal = vi.fn();

      const stopFixtureWatch = adapter.watchDirectory?.(fixtureRoot, onChanges, onSignal);

      expect(stopFixtureWatch).toBeTypeOf('function');
      expect(baseWatchDirectory).not.toHaveBeenCalled();
      stopFixtureWatch?.();
      expect(baseStop).not.toHaveBeenCalled();

      const stopRealWatch = adapter.watchDirectory?.(realDir, onChanges, onSignal);

      expect(baseWatchDirectory).toHaveBeenCalledWith(realDir, onChanges, onSignal);
      expect(stopRealWatch).toBe(baseStop);
    });
  });

  it('rejects fixture streaming with the exact reason without emitting completion when aborted', async () => {
    const adapter = createFixtureCapableAdapter(createBaseAdapter(), { platform: 'web' });
    await adapter.loadInlineFixture(FIXTURE);

    const abortedController = new AbortController();
    const abortReason = new Error('fixture enumeration cancelled');
    abortedController.abort(abortReason);
    const streamed: Array<{ done: boolean; total: number }> = [];
    await expect(
      adapter.readDirectoryStreaming?.(
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
      )
    ).rejects.toBe(abortReason);

    expect(streamed).toEqual([]);
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

  // Regression: dev inline fixture lost file selections across page reloads.
  // A cold reload constructs a FRESH adapter, so the per-session name map is
  // empty and an id minted from crypto.randomUUID() differs every boot. Since
  // selections persist keyed by rootId (folderStates[rootId]) and the root
  // resurrection switches currentFolderId to the new id, the persisted
  // selection orphans. A fixture that DECLARES a durable rootId must keep ONE
  // identity across independent adapter instances so the reload reconciles.
  it('reuses a fixture-declared durable rootId across separate adapter instances (cold reload)', async () => {
    const durable: FixtureDefinition = {
      name: 'mock-project',
      rootId: 'f1e2d3c4-b5a6-4789-8abc-0123456789ab',
      tree: { 'README.md': '# durable' },
    };

    const firstBoot = createFixtureCapableAdapter(createBaseAdapter(), { platform: 'web' });
    const secondBoot = createFixtureCapableAdapter(createBaseAdapter(), { platform: 'web' });
    const first = await firstBoot.loadInlineFixture(durable);
    const second = await secondBoot.loadInlineFixture(durable);

    expect(first.rootId).toBe(durable.rootId);
    expect(second.rootId).toBe(first.rootId);
  });

  it('mints a fresh per-instance rootId for a fixture without a declared rootId', async () => {
    // Contrast: ad-hoc fixtures (multi-root harness, unit tests) are never
    // persisted, so a distinct id per adapter instance is expected — the
    // durability guarantee is opt-in via FixtureDefinition.rootId.
    const firstBoot = createFixtureCapableAdapter(createBaseAdapter(), { platform: 'web' });
    const secondBoot = createFixtureCapableAdapter(createBaseAdapter(), { platform: 'web' });
    const first = await firstBoot.loadInlineFixture(FIXTURE);
    const second = await secondBoot.loadInlineFixture(FIXTURE);

    expect(first.rootId).toBeTruthy();
    expect(second.rootId).not.toBe(first.rootId);
  });

  it('rejects a declared fixture rootId that is not a well-formed UUID (no silent fallback)', async () => {
    // A declared id becomes the canonical identity; downstream dedup reads
    // `rootId !== undefined` as "already stamped", so an empty/malformed id
    // would corrupt folder state silently. It must throw at load instead.
    const adapter = createFixtureCapableAdapter(createBaseAdapter(), { platform: 'web' });
    await expect(
      adapter.loadInlineFixture({ name: 'bad-empty', rootId: '', tree: { 'a.ts': '' } })
    ).rejects.toThrow(/invalid durable rootId/);
    await expect(
      adapter.loadInlineFixture({ name: 'bad-shape', rootId: 'not-a-uuid', tree: { 'a.ts': '' } })
    ).rejects.toThrow(/invalid durable rootId/);
    expect(adapter.isInlineFixtureActive()).toBe(false);
  });

  it('rejects an added fixture root that reuses an active root’s declared rootId', async () => {
    // Two roots sharing an id merge in the rootId-only reducer — fail loud.
    const adapter = createFixtureCapableAdapter(createBaseAdapter(), { platform: 'web' });
    const sharedId = 'f1e2d3c4-b5a6-4789-8abc-0123456789ab';
    await adapter.loadInlineFixture({ name: 'primary', rootId: sharedId, tree: { 'a.ts': '' } });
    await expect(
      adapter.addInlineFixtureRoot({ name: 'secondary', rootId: sharedId, tree: { 'b.ts': '' } })
    ).rejects.toThrow(/already active on another root/);
  });

  it('ships the dev inline fixture with a durable rootId so selections survive reloads', async () => {
    // Guards the actual shipped fixture: dropping its rootId reintroduces the
    // cross-reload selection loss this fix addresses.
    expect(DEV_INLINE_FIXTURE.rootId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );

    const bootA = createFixtureCapableAdapter(createBaseAdapter(), { platform: 'web' });
    const bootB = createFixtureCapableAdapter(createBaseAdapter(), { platform: 'web' });
    const rootA = await bootA.loadInlineFixture(DEV_INLINE_FIXTURE);
    const rootB = await bootB.loadInlineFixture(DEV_INLINE_FIXTURE);
    expect(rootA.rootId).toBe(DEV_INLINE_FIXTURE.rootId);
    expect(rootB.rootId).toBe(rootA.rootId);
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

  it('forwards the explicit absolute-path read capability only when the base has it', async () => {
    const base = createBaseAdapter();
    const readFileByAbsolutePath = vi.fn(
      async (absolutePath: string, rootPath: string, rootId: string) =>
        `${rootId}:${rootPath}:${absolutePath}`
    );
    base.readFileByAbsolutePath = readFileByAbsolutePath;
    const adapter = createFixtureCapableAdapter(base, { platform: 'electron' });

    await expect(
      adapter.readFileByAbsolutePath?.('/workspace/file.txt', '/workspace', 'native-root')
    ).resolves.toBe('native-root:/workspace:/workspace/file.txt');
    expect(readFileByAbsolutePath).toHaveBeenCalledExactlyOnceWith(
      '/workspace/file.txt',
      '/workspace',
      'native-root'
    );
  });

  it('keeps fixture-owned absolute reads inside the active inline fixture', async () => {
    const base = createBaseAdapter();
    const readFileByAbsolutePath = vi.fn(async () => 'real-file');
    base.readFileByAbsolutePath = readFileByAbsolutePath;
    const adapter = createFixtureCapableAdapter(base, { platform: 'electron' });
    const fixtureRoot = await adapter.loadInlineFixture(FIXTURE);

    await expect(
      adapter.readFileByAbsolutePath?.(
        'fixture-root/src/a.ts',
        'fixture-root',
        fixtureRoot.rootId ?? ''
      )
    ).resolves.toBe('export const a = 1;');
    expect(readFileByAbsolutePath).not.toHaveBeenCalled();

    await expect(
      adapter.readFileByAbsolutePath?.('/real-root/file.ts', '/real-root', 'real-root-id')
    ).resolves.toBe('real-file');
    expect(readFileByAbsolutePath).toHaveBeenCalledExactlyOnceWith(
      '/real-root/file.ts',
      '/real-root',
      'real-root-id'
    );
  });

  describe('addInlineFixtureRoot (multi-root harness)', () => {
    const SECOND_FIXTURE: FixtureDefinition = {
      name: 'second-root',
      tree: {
        docs: {
          'guide.md': '# guide',
        },
        'top.ts': 'export const t = 1;',
      },
    };

    it('serves reads for every active fixture root', async () => {
      const adapter = createFixtureCapableAdapter(createBaseAdapter(), { platform: 'web' });
      const first = await adapter.loadInlineFixture(FIXTURE);
      const second = await adapter.addInlineFixtureRoot(SECOND_FIXTURE);

      expect(second.path).toBe('second-root');
      expect(second.rootId).toBeTruthy();
      expect(second.rootId).not.toBe(first.rootId);

      const firstNodes = await adapter.readDirectory(first);
      expect(firstNodes.map((node) => node.name)).toContain('src');

      const secondNodes = await adapter.readDirectory(second);
      expect(secondNodes.map((node) => node.name)).toEqual(['docs', 'top.ts']);

      const docsChildren = await adapter.readDirectory({
        kind: 'directory',
        name: 'docs',
        path: 'second-root/docs',
        platform: 'web',
      });
      expect(docsChildren.map((node) => node.name)).toEqual(['guide.md']);

      await expect(
        adapter.readFile({
          kind: 'file',
          name: 'guide.md',
          path: 'second-root/docs/guide.md',
          platform: 'web',
          size: 7,
        })
      ).resolves.toBe('# guide');
      await expect(adapter.exists('second-root/docs')).resolves.toBe(true);
    });

    it('streams the added root through readDirectoryStreaming', async () => {
      const adapter = createFixtureCapableAdapter(createBaseAdapter(), { platform: 'web' });
      await adapter.loadInlineFixture(FIXTURE);
      const second = await adapter.addInlineFixtureRoot(SECOND_FIXTURE);

      const batches: IFileNode[][] = [];
      const onBatch: DirectoryStreamCallback = (nodes) => {
        batches.push(nodes);
      };
      await adapter.readDirectoryStreaming?.(second, onBatch);
      expect(batches.flat().map((node) => node.name)).toEqual(['docs', 'top.ts']);
    });

    it('throws without an active primary fixture — the harness must not half-activate', async () => {
      const adapter = createFixtureCapableAdapter(createBaseAdapter(), { platform: 'web' });
      await expect(adapter.addInlineFixtureRoot(SECOND_FIXTURE)).rejects.toThrow(
        /requires an active inline fixture/
      );
    });

    it('throws on a duplicate fixture root name', async () => {
      const adapter = createFixtureCapableAdapter(createBaseAdapter(), { platform: 'web' });
      await adapter.loadInlineFixture(FIXTURE);
      await adapter.addInlineFixtureRoot(SECOND_FIXTURE);
      await expect(adapter.addInlineFixtureRoot(SECOND_FIXTURE)).rejects.toThrow(/already active/);
    });

    it('keeps the added root id durable across re-adds after a clear', async () => {
      const adapter = createFixtureCapableAdapter(createBaseAdapter(), { platform: 'web' });
      await adapter.loadInlineFixture(FIXTURE);
      const second = await adapter.addInlineFixtureRoot(SECOND_FIXTURE);
      await adapter.clearInlineFixture();
      await adapter.loadInlineFixture(FIXTURE);
      const readded = await adapter.addInlineFixtureRoot(SECOND_FIXTURE);
      // Same durable rootId → the reducer reconciles instead of duplicating
      // (the #1200 "two treegrids" class).
      expect(readded.rootId).toBe(second.rootId);
    });

    it('clearInlineFixture deactivates every root', async () => {
      const base = createBaseAdapter();
      // Decoration mutates the base adapter in place — capture the spy first.
      const baseReadDirectory = base.readDirectory;
      const adapter = createFixtureCapableAdapter(base, { platform: 'web' });
      await adapter.loadInlineFixture(FIXTURE);
      const second = await adapter.addInlineFixtureRoot(SECOND_FIXTURE);
      await adapter.clearInlineFixture();

      expect(adapter.isInlineFixtureActive()).toBe(false);
      await adapter.readDirectory(second);
      expect(baseReadDirectory).toHaveBeenCalled();
    });
  });
});
