import type { WorkspaceCollectionSyncStatusPatch } from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
import type { DbHandle } from '@brainstrike/db/react';
import type { DirectoryHandle, FileSystemAdapter } from '@brainstrike/file-system';
import { addLogListener, type LogRecord } from '@brainstrike/logging';
import type { IFileNode } from '@brainstrike/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCoverageAuditKey,
  createCoverageStatusPatch,
  createUnresolvedRootCoverageMessage,
  readIndexedFileCountsByRoot,
  startWorkspaceCoverageAudit,
} from '../workspace-index-coverage-audit-runner';

/**
 * Direct tests for the coverage-audit ORCHESTRATION layer
 * (`workspace-index-coverage-audit-runner.ts`), paired with the contract in
 * `packages/app-shell/AGENTS.md`. The pure primitives it composes are covered
 * by `workspace-index-coverage-audit.test.ts`; the mounted-provider
 * integration is covered by `workspace-collection-sync-provider.test.tsx`.
 * The runner needs no React and no PGlite, so everything here is constructed
 * directly: only the two collaborators that touch the outside world (the
 * directory walk and the file-content reader) are stubbed.
 */

const { processFilesMock, readFullTreeWithOptionsMock } = vi.hoisted(() => ({
  processFilesMock: vi.fn(),
  readFullTreeWithOptionsMock: vi.fn(),
}));

vi.mock('@brainstrike/file-explorer-ui/tree', () => ({
  readFullTreeWithOptions: readFullTreeWithOptionsMock,
}));

vi.mock('@brainstrike/file-explorer-hooks', () => ({
  createFileContentProcessor: () => ({ processFiles: processFilesMock }),
}));

const COLLECTION_ID = '00000000-0000-0000-0000-000000000101';
const ROOT_PATH = '/workspace/root';
const SECOND_ROOT_PATH = '/workspace/other';

const fileSystemAdapter = {} as FileSystemAdapter;

interface TreeFixture {
  readonly nodes: readonly IFileNode[];
  readonly truncatedDirectoryPaths: readonly string[];
}

const treesByRootPath = new Map<string, TreeFixture>();

function makeDirectoryHandle(path: string, rootId?: string): DirectoryHandle {
  return {
    kind: 'directory',
    name: path.split('/').at(-1) ?? path,
    path,
    platform: 'electron',
    ...(rootId === undefined ? {} : { rootId }),
  };
}

function makeFileNode(rootPath: string, relativePath: string): IFileNode {
  const absolutePath = `${rootPath}/${relativePath}`;
  const name = relativePath.split('/').at(-1) ?? relativePath;
  return {
    depth: relativePath.split('/').length,
    handle: {
      kind: 'file',
      name,
      path: absolutePath,
      platform: 'electron',
    } as unknown as IFileNode['handle'],
    name,
    path: absolutePath,
    rootFolderId: rootPath,
    selectionState: 'unchecked',
    type: 'file',
  };
}

function setTree(
  rootPath: string,
  relativePaths: readonly string[],
  truncatedDirectoryPaths: readonly string[] = []
): void {
  treesByRootPath.set(rootPath, {
    nodes: relativePaths.map((relativePath) => makeFileNode(rootPath, relativePath)),
    truncatedDirectoryPaths,
  });
}

/** A `DbHandle` stand-in that answers only the audit's indexed-paths query. */
function createDb(indexedPathsByRootId: Record<string, readonly string[]>): {
  db: DbHandle;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('SELECT root_id, path')) {
      return {
        rows: Object.entries(indexedPathsByRootId).flatMap(([rootId, paths]) =>
          paths.map((path) => ({ path, root_id: rootId }))
        ),
      };
    }
    return { rows: [] };
  });
  return { db: { query } as unknown as DbHandle, query };
}

interface RunAuditOverrides {
  activeRootPath?: string | null;
  auditKey?: string;
  db?: DbHandle;
  handles?: readonly DirectoryHandle[];
  isCurrent?: () => boolean;
  resolveDbRootId?: (path: string, rootId?: string) => Promise<string | null>;
  rootIdByPath?: ReadonlyMap<string, string>;
}

interface RunAuditResult {
  clearInFlightAudit: ReturnType<typeof vi.fn>;
  markAuditVerified: ReturnType<typeof vi.fn>;
  recoveryAttemptKey: string | null;
  resolveDbRootId: ReturnType<typeof vi.fn>;
  statuses: WorkspaceCollectionSyncStatusPatch[];
}

async function runAudit(overrides: RunAuditOverrides = {}): Promise<RunAuditResult> {
  const statuses: WorkspaceCollectionSyncStatusPatch[] = [];
  const clearInFlightAudit = vi.fn();
  const markAuditVerified = vi.fn();
  const resolveDbRootId = vi.fn(
    overrides.resolveDbRootId ?? (async (path: string) => `db-root:${path}`)
  );
  const recoveryAttemptKey = await startWorkspaceCoverageAudit({
    activeRootPath: overrides.activeRootPath === undefined ? ROOT_PATH : overrides.activeRootPath,
    auditKey: overrides.auditKey ?? 'audit-key',
    clearInFlightAudit,
    collectionId: COLLECTION_ID,
    db: overrides.db ?? createDb({}).db,
    fileSystemAdapter,
    handles: overrides.handles ?? [makeDirectoryHandle(ROOT_PATH)],
    isCurrent: overrides.isCurrent ?? (() => true),
    markAuditVerified,
    policyPreset: 'balanced',
    resolveDbRootId,
    rootIdByPath: overrides.rootIdByPath ?? new Map(),
    setStatus: (patch) => {
      statuses.push(patch);
    },
  });
  return { clearInFlightAudit, markAuditVerified, recoveryAttemptKey, resolveDbRootId, statuses };
}

/**
 * Models how the status store applies these patches: zustand shallow-merges a
 * partial, so an omitted key keeps whatever the previous patch published.
 */
function mergeStatusPatches(
  patches: readonly WorkspaceCollectionSyncStatusPatch[]
): WorkspaceCollectionSyncStatusPatch {
  const merged: WorkspaceCollectionSyncStatusPatch = {};
  for (const patch of patches) {
    Object.assign(merged, patch);
  }
  return merged;
}

function captureLogs(predicate: (record: LogRecord) => boolean): {
  records: LogRecord[];
  stop: () => void;
} {
  const records: LogRecord[] = [];
  const stop = addLogListener((record) => {
    if (predicate(record)) {
      records.push(record);
    }
  });
  return { records, stop };
}

beforeEach(() => {
  treesByRootPath.clear();
  readFullTreeWithOptionsMock.mockReset();
  readFullTreeWithOptionsMock.mockImplementation(
    async (
      _adapter: unknown,
      handle: DirectoryHandle,
      options?: { onDirectoryTruncated?: (event: { depth: number; path: string }) => void }
    ) => {
      const fixture = treesByRootPath.get(handle.path);
      if (!fixture) {
        throw new Error(`No tree fixture registered for ${handle.path}`);
      }
      for (const path of fixture.truncatedDirectoryPaths) {
        options?.onDirectoryTruncated?.({ depth: 0, path });
      }
      return fixture.nodes;
    }
  );
  processFilesMock.mockReset();
  // Default: every missing file reads back as ordinary indexable text, so a
  // missing file is a genuine gap unless a test says otherwise.
  processFilesMock.mockImplementation(async (requests: Array<{ compositeKey: string }>) =>
    Object.fromEntries(
      requests.map((request) => [
        request.compositeKey,
        { content: 'export const value = 1;', status: 'accessible' as const },
      ])
    )
  );
});

describe('startWorkspaceCoverageAudit target assembly', () => {
  it('builds one target per mounted root and prefers the handle root id over the path map', async () => {
    setTree(ROOT_PATH, ['src/index.ts']);
    setTree(SECOND_ROOT_PATH, ['notes.md']);
    const { db } = createDb({
      'db-root:/workspace/other': ['notes.md'],
      'db-root:/workspace/root': ['src/index.ts'],
    });

    const { markAuditVerified, resolveDbRootId, statuses } = await runAudit({
      db,
      handles: [
        makeDirectoryHandle(ROOT_PATH, 'adapter-root-from-handle'),
        makeDirectoryHandle(SECOND_ROOT_PATH),
      ],
      rootIdByPath: new Map([
        // Ignored for the first root: the handle carries its own id.
        [ROOT_PATH, 'adapter-root-from-map'],
        [SECOND_ROOT_PATH, 'adapter-root-from-map-2'],
      ]),
    });

    expect(resolveDbRootId.mock.calls).toEqual([
      [ROOT_PATH, 'adapter-root-from-handle'],
      [SECOND_ROOT_PATH, 'adapter-root-from-map-2'],
    ]);
    expect(readFullTreeWithOptionsMock).toHaveBeenCalledTimes(2);
    expect(markAuditVerified).toHaveBeenCalledWith('audit-key');
    expect(statuses.at(-1)?.state).toBe('idle');
  });

  it('passes an undefined adapter root id when neither the handle nor the map knows one', async () => {
    setTree(ROOT_PATH, []);
    const { resolveDbRootId } = await runAudit();
    expect(resolveDbRootId).toHaveBeenCalledWith(ROOT_PATH, undefined);
  });

  it('dedupes expected files by normalized relative path before comparing coverage', async () => {
    // The DB is keyed by (rootId, relativePath), so two nodes normalizing to
    // the same relative path are ONE expected file — otherwise a fully indexed
    // root would read as 1/2 covered.
    setTree(ROOT_PATH, ['src/index.ts', 'src/index.ts']);
    const { db } = createDb({ 'db-root:/workspace/root': ['src/index.ts'] });

    const { markAuditVerified, recoveryAttemptKey } = await runAudit({ db });

    expect(recoveryAttemptKey).toBeNull();
    expect(markAuditVerified).toHaveBeenCalledTimes(1);
  });
});

describe('startWorkspaceCoverageAudit complete outcome', () => {
  it('marks the audit verified and publishes an idle status patch', async () => {
    setTree(ROOT_PATH, ['src/index.ts', 'docs/readme.md']);
    const { db, query } = createDb({
      'db-root:/workspace/root': ['src/index.ts', 'docs/readme.md'],
    });

    const { clearInFlightAudit, markAuditVerified, recoveryAttemptKey, statuses } = await runAudit({
      db,
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(markAuditVerified).toHaveBeenCalledWith('audit-key');
    expect(statuses).toEqual([
      {
        activeRootPath: ROOT_PATH,
        currentFilePath: null,
        lastError: null,
        managedCollectionId: COLLECTION_ID,
        pauseReasons: [],
        queuedFiles: 0,
        state: 'idle',
        unindexableFileCount: 0,
      },
    ]);
    // A complete audit needs no recovery sync.
    expect(recoveryAttemptKey).toBeNull();
    expect(clearInFlightAudit).toHaveBeenCalledWith('audit-key');
  });

  it('counts content-excluded missing files as covered and publishes the unindexable count', async () => {
    setTree(ROOT_PATH, ['src/index.ts', 'assets/binary.md']);
    const { db } = createDb({ 'db-root:/workspace/root': ['src/index.ts'] });
    processFilesMock.mockImplementation(async (requests: Array<{ compositeKey: string }>) =>
      Object.fromEntries(
        requests.map((request) => [
          request.compositeKey,
          { content: 'binary\0content', status: 'accessible' as const },
        ])
      )
    );
    const exclusionLogs = captureLogs((record) =>
      (record.message ?? '').includes('unindexable files excluded from coverage by content policy')
    );

    try {
      const { markAuditVerified, recoveryAttemptKey, statuses } = await runAudit({ db });

      expect(markAuditVerified).toHaveBeenCalledWith('audit-key');
      expect(recoveryAttemptKey).toBeNull();
      expect(statuses.at(-1)).toMatchObject({ state: 'idle', unindexableFileCount: 1 });
      expect(exclusionLogs.records).toHaveLength(1);
      expect(JSON.stringify(exclusionLogs.records[0]?.args ?? [])).toContain('assets/binary.md');
    } finally {
      exclusionLogs.stop();
    }
  });
});

describe('startWorkspaceCoverageAudit incomplete outcome', () => {
  it('composes a waiting status patch naming the missing files and returns a recovery key', async () => {
    setTree(ROOT_PATH, ['src/index.ts', 'src/missed.ts']);
    const { db } = createDb({ 'db-root:/workspace/root': ['src/index.ts'] });

    const { markAuditVerified, recoveryAttemptKey, statuses } = await runAudit({ db });

    expect(markAuditVerified).not.toHaveBeenCalled();
    const patch = statuses.at(-1);
    expect(patch).toMatchObject({
      // The incomplete patch re-points activeRootPath at the FIRST incomplete
      // root, not at the caller's activeRootPath.
      activeRootPath: ROOT_PATH,
      state: 'waiting',
      unindexableFileCount: 0,
    });
    expect(patch?.lastError).toBe(
      'Workspace Index coverage is incomplete after the pipeline reported idle: ' +
        '/workspace/root (1/2 files indexed; missing files include: src/missed.ts). ' +
        'A full recovery sync is required before this index can be treated as complete. ' +
        'First incomplete root: /workspace/root.'
    );
    expect(recoveryAttemptKey).toBe('audit-key:db-root:/workspace/root:/workspace/root:1/2');
  });

  it('samples at most three missing paths and reports the remainder as "+N more"', async () => {
    setTree(ROOT_PATH, ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']);
    const { db } = createDb({ 'db-root:/workspace/root': [] });

    const { statuses } = await runAudit({ db });

    expect(statuses.at(-1)?.lastError).toContain(
      'missing files include: a.ts, b.ts, c.ts (+2 more)'
    );
  });

  it('reports content exclusions and the unclassified remainder alongside the real gap', async () => {
    // 201 missing files exceeds the classification read budget (200), so the
    // tail is reported unclassified rather than silently dropped.
    const missing = Array.from({ length: 201 }, (_, index) => `missed-${index}.ts`);
    setTree(ROOT_PATH, missing);
    const { db } = createDb({ 'db-root:/workspace/root': [] });
    processFilesMock.mockImplementation(async (requests: Array<{ compositeKey: string }>) =>
      Object.fromEntries(
        requests.map((request, index) => [
          request.compositeKey,
          index === 0
            ? { message: 'Binary file - preview not available', status: 'inaccessible' as const }
            : { content: 'export const value = 1;', status: 'accessible' as const },
        ])
      )
    );

    const { statuses } = await runAudit({ db });

    const lastError = statuses.at(-1)?.lastError ?? '';
    expect(lastError).toContain('1 additional missing files were not classified');
    expect(lastError).toContain('1 files are unindexable by content policy');
    expect(statuses.at(-1)?.unindexableFileCount).toBe(1);
  });

  it('summarizes at most three incomplete roots and counts the rest', async () => {
    const rootPaths = ['/workspace/r1', '/workspace/r2', '/workspace/r3', '/workspace/r4'];
    for (const rootPath of rootPaths) {
      setTree(rootPath, ['missed.ts']);
    }
    const { db } = createDb({});

    const { statuses } = await runAudit({
      db,
      handles: rootPaths.map((rootPath) => makeDirectoryHandle(rootPath)),
    });

    const lastError = statuses.at(-1)?.lastError ?? '';
    expect(lastError).toContain('/workspace/r3 (0/1 files indexed');
    expect(lastError).not.toContain('/workspace/r4 (0/1 files indexed');
    expect(lastError).toContain('; +1 more.');
    expect(statuses.at(-1)?.activeRootPath).toBe('/workspace/r1');
  });

  it('logs the per-root gap diagnostics for the incomplete roots', async () => {
    setTree(ROOT_PATH, ['src/index.ts', 'src/missed.ts']);
    const { db } = createDb({ 'db-root:/workspace/root': ['src/index.ts'] });
    const warnings = captureLogs(
      (record) => record.message === 'Workspace Index idle coverage audit found incomplete roots'
    );

    try {
      await runAudit({ db });
      expect(warnings.records).toHaveLength(1);
      expect(warnings.records[0]?.args).toContainEqual({
        collectionId: COLLECTION_ID,
        missingRoots: [
          {
            contentExcluded: [],
            expectedFileCount: 2,
            genuinelyMissing: ['src/missed.ts'],
            indexedFileCount: 1,
            rootPath: ROOT_PATH,
            unclassifiedCount: 0,
          },
        ],
      });
    } finally {
      warnings.stop();
    }
  });
});

describe('startWorkspaceCoverageAudit unverifiable outcomes', () => {
  it('reports an unresolved database root id as unverifiable, not as a gap', async () => {
    setTree(ROOT_PATH, ['src/index.ts']);
    const { db, query } = createDb({});

    const { clearInFlightAudit, markAuditVerified, recoveryAttemptKey, statuses } = await runAudit({
      activeRootPath: null,
      db,
      resolveDbRootId: async () => null,
    });

    expect(statuses).toEqual([
      {
        // The unverifiable patch names the offending root, overriding the
        // caller's activeRootPath (null here).
        activeRootPath: ROOT_PATH,
        currentFilePath: null,
        lastError: createUnresolvedRootCoverageMessage(ROOT_PATH),
        managedCollectionId: COLLECTION_ID,
        pauseReasons: [],
        queuedFiles: 0,
        state: 'waiting',
        // Explicit absence, not omission: nothing was verified, so no count
        // may survive from the previous audit.
        unindexableFileCount: null,
      },
    ]);
    // Neither "covered" nor "gap": no verification, and no recovery sync.
    expect(markAuditVerified).not.toHaveBeenCalled();
    expect(recoveryAttemptKey).toBeNull();
    // Unverifiable short-circuits before the coverage comparison.
    expect(query).not.toHaveBeenCalled();
    expect(clearInFlightAudit).toHaveBeenCalledWith('audit-key');
  });

  it('skips the directory walk for a root with no resolved database root id', async () => {
    setTree(SECOND_ROOT_PATH, ['notes.md']);
    await runAudit({
      handles: [makeDirectoryHandle(ROOT_PATH), makeDirectoryHandle(SECOND_ROOT_PATH)],
      resolveDbRootId: async (path: string) => (path === ROOT_PATH ? null : `db-root:${path}`),
    });
    // No fixture is registered for ROOT_PATH; the walk mock would throw if the
    // unresolved root were enumerated.
    expect(
      readFullTreeWithOptionsMock.mock.calls.map(
        (call: unknown[]) => (call[1] as DirectoryHandle | undefined)?.path
      )
    ).toEqual([SECOND_ROOT_PATH]);
  });

  it('never verifies coverage complete from a truncated enumeration, even when the prefix is fully indexed', async () => {
    setTree(ROOT_PATH, ['src/index.ts'], [`${ROOT_PATH}/src`]);
    // Every enumerated file IS indexed — only truncation makes this unverifiable.
    const { db, query } = createDb({ 'db-root:/workspace/root': ['src/index.ts'] });
    const warnings = captureLogs((record) =>
      (record.message ?? '').includes('coverage cannot be verified for root')
    );

    try {
      const { markAuditVerified, recoveryAttemptKey, statuses } = await runAudit({ db });

      expect(markAuditVerified).not.toHaveBeenCalled();
      expect(recoveryAttemptKey).toBeNull();
      expect(query).not.toHaveBeenCalled();
      expect(statuses).toEqual([
        {
          activeRootPath: ROOT_PATH,
          currentFilePath: null,
          lastError:
            'Workspace Index coverage cannot be verified for root /workspace/root: 1 directory listing was truncated at the enumeration cap, so the expected file set is a partial prefix.',
          managedCollectionId: COLLECTION_ID,
          pauseReasons: [],
          queuedFiles: 0,
          state: 'waiting',
          unindexableFileCount: null,
        },
      ]);
      expect(warnings.records[0]?.args).toContainEqual({ rootPath: ROOT_PATH });
    } finally {
      warnings.stop();
    }
  });

  it('pluralizes the truncated-listing count', async () => {
    setTree(ROOT_PATH, ['src/index.ts'], [`${ROOT_PATH}/src`, `${ROOT_PATH}/docs`]);
    const { statuses } = await runAudit();
    expect(statuses.at(-1)?.lastError).toContain('2 directory listings were truncated');
  });

  it('clears a previously published unindexable count on a truncated root', async () => {
    // The status store shallow-merges each patch, so a patch that OMITS
    // unindexableFileCount leaves the previous audit's number on screen —
    // "3 files skipped" sitting beside "coverage cannot be verified".
    setTree(ROOT_PATH, ['src/index.ts', 'assets/binary.md']);
    const { db } = createDb({ 'db-root:/workspace/root': ['src/index.ts'] });
    processFilesMock.mockImplementation(async (requests: Array<{ compositeKey: string }>) =>
      Object.fromEntries(
        requests.map((request) => [
          request.compositeKey,
          { content: 'binary\u0000content', status: 'accessible' as const },
        ])
      )
    );

    const verified = await runAudit({ db });
    expect(verified.statuses.at(-1)?.unindexableFileCount).toBe(1);

    setTree(ROOT_PATH, ['src/index.ts'], [`${ROOT_PATH}/src`]);
    const unverifiable = await runAudit({ db });

    expect(unverifiable.statuses.at(-1)?.unindexableFileCount).toBeNull();
    expect(mergeStatusPatches([...verified.statuses, ...unverifiable.statuses])).toMatchObject({
      lastError: expect.stringContaining('coverage cannot be verified'),
      unindexableFileCount: null,
    });
  });

  it('clears a previously published unindexable count on an unresolved root', async () => {
    setTree(ROOT_PATH, ['src/index.ts', 'assets/binary.md']);
    const { db } = createDb({ 'db-root:/workspace/root': ['src/index.ts'] });
    processFilesMock.mockImplementation(async (requests: Array<{ compositeKey: string }>) =>
      Object.fromEntries(
        requests.map((request) => [
          request.compositeKey,
          { content: 'binary\u0000content', status: 'accessible' as const },
        ])
      )
    );

    const verified = await runAudit({ db });
    const unverifiable = await runAudit({ db, resolveDbRootId: async () => null });

    expect(mergeStatusPatches([...verified.statuses, ...unverifiable.statuses])).toMatchObject({
      lastError: createUnresolvedRootCoverageMessage(ROOT_PATH),
      unindexableFileCount: null,
    });
  });

  it('reports the first unverifiable root in mounted order', async () => {
    setTree(ROOT_PATH, ['src/index.ts'], [`${ROOT_PATH}/src`]);
    const { statuses } = await runAudit({
      handles: [makeDirectoryHandle(ROOT_PATH), makeDirectoryHandle(SECOND_ROOT_PATH)],
      // The SECOND root is unresolved; the FIRST is truncated. Mounted order,
      // not outcome kind, decides which one is reported.
      resolveDbRootId: async (path: string) => (path === ROOT_PATH ? `db-root:${path}` : null),
    });
    expect(statuses.at(-1)?.lastError).toContain('cannot be verified for root /workspace/root');
  });
});

describe('startWorkspaceCoverageAudit cancellation and failure', () => {
  it('publishes nothing when the audit is no longer current, but still clears the in-flight slot', async () => {
    setTree(ROOT_PATH, ['src/index.ts']);
    const { clearInFlightAudit, markAuditVerified, recoveryAttemptKey, statuses } = await runAudit({
      isCurrent: () => false,
    });

    expect(statuses).toEqual([]);
    expect(markAuditVerified).not.toHaveBeenCalled();
    expect(recoveryAttemptKey).toBeNull();
    expect(readFullTreeWithOptionsMock).not.toHaveBeenCalled();
    expect(clearInFlightAudit).toHaveBeenCalledWith('audit-key');
  });

  it('abandons the audit when currency is lost after the walk', async () => {
    setTree(ROOT_PATH, ['src/index.ts']);
    let calls = 0;
    const { db } = createDb({});
    const { recoveryAttemptKey, statuses } = await runAudit({
      db,
      isCurrent: () => {
        calls += 1;
        return calls < 2;
      },
    });
    // The walk ran; only the post-walk currency check stopped the audit.
    expect(readFullTreeWithOptionsMock).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual([]);
    expect(recoveryAttemptKey).toBeNull();
  });

  it('surfaces a walk failure as an error status instead of a coverage verdict', async () => {
    readFullTreeWithOptionsMock.mockRejectedValue(new Error('adapter exploded'));

    const { clearInFlightAudit, markAuditVerified, recoveryAttemptKey, statuses } =
      await runAudit();

    expect(markAuditVerified).not.toHaveBeenCalled();
    expect(recoveryAttemptKey).toBeNull();
    expect(statuses).toEqual([
      {
        activeRootPath: ROOT_PATH,
        currentFilePath: null,
        lastError: 'Workspace Index coverage audit failed: adapter exploded',
        managedCollectionId: COLLECTION_ID,
        pauseReasons: [],
        queuedFiles: 0,
        state: 'error',
        // A failed audit verified nothing either.
        unindexableFileCount: null,
      },
    ]);
    expect(clearInFlightAudit).toHaveBeenCalledWith('audit-key');
  });

  it('clears a previously published unindexable count when the audit fails', async () => {
    setTree(ROOT_PATH, ['src/index.ts', 'assets/binary.md']);
    const { db } = createDb({ 'db-root:/workspace/root': ['src/index.ts'] });
    processFilesMock.mockImplementation(async (requests: Array<{ compositeKey: string }>) =>
      Object.fromEntries(
        requests.map((request) => [
          request.compositeKey,
          { content: 'binary\u0000content', status: 'accessible' as const },
        ])
      )
    );
    const verified = await runAudit({ db });

    readFullTreeWithOptionsMock.mockRejectedValue(new Error('adapter exploded'));
    const failed = await runAudit({ db });

    expect(mergeStatusPatches([...verified.statuses, ...failed.statuses])).toMatchObject({
      state: 'error',
      unindexableFileCount: null,
    });
  });

  it('swallows a failure that lands after the audit stopped being current', async () => {
    readFullTreeWithOptionsMock.mockRejectedValue(new Error('adapter exploded'));
    let calls = 0;
    const { clearInFlightAudit, statuses } = await runAudit({
      isCurrent: () => {
        calls += 1;
        // Current for the initial gate, stale by the time the rejection lands.
        return calls === 1;
      },
    });
    expect(statuses).toEqual([]);
    expect(clearInFlightAudit).toHaveBeenCalledWith('audit-key');
  });
});

describe('recovery-attempt keying', () => {
  async function runIncompleteAudit(
    auditKey: string,
    handles: readonly DirectoryHandle[],
    indexed: Record<string, readonly string[]>
  ): Promise<string | null> {
    const { db } = createDb(indexed);
    const { recoveryAttemptKey } = await runAudit({ auditKey, db, handles });
    return recoveryAttemptKey;
  }

  it('returns the same key for an unchanged incomplete result so one gap triggers one recovery', async () => {
    setTree(ROOT_PATH, ['src/index.ts', 'src/missed.ts']);
    const handles = [makeDirectoryHandle(ROOT_PATH)];
    const indexed = { 'db-root:/workspace/root': ['src/index.ts'] };

    const first = await runIncompleteAudit('audit-key', handles, indexed);
    const second = await runIncompleteAudit('audit-key', handles, indexed);

    expect(first).toBe(second);
    expect(first).not.toBeNull();
  });

  it('changes the key when the indexed count moves, so progress re-arms recovery', async () => {
    setTree(ROOT_PATH, ['a.ts', 'b.ts', 'c.ts']);
    const handles = [makeDirectoryHandle(ROOT_PATH)];

    const before = await runIncompleteAudit('audit-key', handles, {
      'db-root:/workspace/root': ['a.ts'],
    });
    const after = await runIncompleteAudit('audit-key', handles, {
      'db-root:/workspace/root': ['a.ts', 'b.ts'],
    });

    expect(before).toBe('audit-key:db-root:/workspace/root:/workspace/root:1/3');
    expect(after).toBe('audit-key:db-root:/workspace/root:/workspace/root:2/3');
  });

  it('is stable across mounted-root ordering', async () => {
    setTree(ROOT_PATH, ['missed.ts']);
    setTree(SECOND_ROOT_PATH, ['missed.md']);
    const first = makeDirectoryHandle(ROOT_PATH);
    const second = makeDirectoryHandle(SECOND_ROOT_PATH);

    const forward = await runIncompleteAudit('audit-key', [first, second], {});
    const reversed = await runIncompleteAudit('audit-key', [second, first], {});

    expect(forward).toBe(reversed);
  });

  it('is namespaced by the audit key, so a different collection or root set re-arms recovery', async () => {
    setTree(ROOT_PATH, ['missed.ts']);
    const handles = [makeDirectoryHandle(ROOT_PATH)];

    const first = await runIncompleteAudit('audit-key-a', handles, {});
    const second = await runIncompleteAudit('audit-key-b', handles, {});

    expect(first).not.toBe(second);
  });
});

describe('createCoverageAuditKey', () => {
  it('keys on the collection, the policy preset, and every mounted root identity', () => {
    expect(
      createCoverageAuditKey({
        collectionId: 'collection-1',
        handles: [
          makeDirectoryHandle(ROOT_PATH, 'adapter-root-1'),
          makeDirectoryHandle(SECOND_ROOT_PATH),
        ],
        policyPreset: 'balanced',
        rootIdByPath: new Map([[SECOND_ROOT_PATH, 'adapter-root-2']]),
      })
    ).toBe('collection-1:balanced:/workspace/root:adapter-root-1|/workspace/other:adapter-root-2');
  });

  it('falls back to an empty root id when neither the handle nor the map knows one', () => {
    expect(
      createCoverageAuditKey({
        collectionId: 'collection-1',
        handles: [makeDirectoryHandle(ROOT_PATH)],
        policyPreset: 'full-root',
        rootIdByPath: new Map(),
      })
    ).toBe('collection-1:full-root:/workspace/root:');
  });

  it('changes when the policy preset changes', () => {
    const handles = [makeDirectoryHandle(ROOT_PATH, 'adapter-root-1')];
    const rootIdByPath = new Map<string, string>();
    expect(
      createCoverageAuditKey({
        collectionId: 'collection-1',
        handles,
        policyPreset: 'balanced',
        rootIdByPath,
      })
    ).not.toBe(
      createCoverageAuditKey({
        collectionId: 'collection-1',
        handles,
        policyPreset: 'full-root',
        rootIdByPath,
      })
    );
  });
});

describe('createCoverageStatusPatch', () => {
  it('omits unindexableFileCount when the caller has no count to publish', () => {
    const patch = createCoverageStatusPatch({
      activeRootPath: ROOT_PATH,
      collectionId: COLLECTION_ID,
      lastError: 'boom',
      state: 'error',
    });
    expect(patch).toEqual({
      activeRootPath: ROOT_PATH,
      currentFilePath: null,
      lastError: 'boom',
      managedCollectionId: COLLECTION_ID,
      pauseReasons: [],
      queuedFiles: 0,
      state: 'error',
    });
    expect('unindexableFileCount' in patch).toBe(false);
  });

  it('publishes an explicit zero count (clearing a stale one) rather than omitting it', () => {
    const patch = createCoverageStatusPatch({
      activeRootPath: null,
      collectionId: COLLECTION_ID,
      lastError: null,
      state: 'idle',
      unindexableFileCount: 0,
    });
    expect(patch.unindexableFileCount).toBe(0);
  });
});

describe('createUnresolvedRootCoverageMessage', () => {
  it('names the root that has no resolved database root id', () => {
    expect(createUnresolvedRootCoverageMessage(ROOT_PATH)).toBe(
      'Workspace Index coverage cannot be verified because root /workspace/root has no resolved database root id.'
    );
  });
});

describe('readIndexedFileCountsByRoot', () => {
  it('returns an empty map without querying when no roots are given', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const counts = await readIndexedFileCountsByRoot({
      collectionId: COLLECTION_ID,
      db: { query } as unknown as DbHandle,
      rootIds: [],
    });
    expect(query).not.toHaveBeenCalled();
    expect(counts.size).toBe(0);
  });

  it('binds one placeholder per root after the collection id', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }));
    await readIndexedFileCountsByRoot({
      collectionId: COLLECTION_ID,
      db: { query } as unknown as DbHandle,
      rootIds: ['root-a', 'root-b'],
    });
    expect(query.mock.calls[0]?.[0]).toContain('root_id IN ($2, $3)');
    expect(query.mock.calls[0]?.[1]).toEqual([COLLECTION_ID, 'root-a', 'root-b']);
  });

  it('parses driver count shapes: number, bigint, and numeric string', async () => {
    const query = vi.fn(async () => ({
      rows: [
        { file_count: 3, root_id: 'root-a' },
        { file_count: 7n, root_id: 'root-b' },
        { file_count: '11', root_id: 'root-c' },
      ],
    }));
    const counts = await readIndexedFileCountsByRoot({
      collectionId: COLLECTION_ID,
      db: { query } as unknown as DbHandle,
      rootIds: ['root-a', 'root-b', 'root-c'],
    });
    expect([...counts]).toEqual([
      ['root-a', 3],
      ['root-b', 7],
      ['root-c', 11],
    ]);
  });

  it('accepts camelCase and bare "count" column aliases', async () => {
    const query = vi.fn(async () => ({
      rows: [
        { fileCount: 2, rootId: 'root-a' },
        { count: 5, root_id: 'root-b' },
      ],
    }));
    const counts = await readIndexedFileCountsByRoot({
      collectionId: COLLECTION_ID,
      db: { query } as unknown as DbHandle,
      rootIds: ['root-a', 'root-b'],
    });
    expect(counts.get('root-a')).toBe(2);
    expect(counts.get('root-b')).toBe(5);
  });

  it('drops rows with no usable root id and zeroes unparseable counts', async () => {
    const query = vi.fn(async () => ({
      rows: [
        null,
        'nonsense',
        { file_count: 1 },
        { root_id: '' },
        { file_count: {}, root_id: 'a' },
      ],
    }));
    const counts = await readIndexedFileCountsByRoot({
      collectionId: COLLECTION_ID,
      db: { query } as unknown as DbHandle,
      rootIds: ['a'],
    });
    expect([...counts]).toEqual([['a', 0]]);
  });
});
