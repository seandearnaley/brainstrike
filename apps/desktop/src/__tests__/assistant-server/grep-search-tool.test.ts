import type { RuntimeData } from '@brainstrike/agent';
import { markBrainstrikeDbExecutionRuntime } from '@brainstrike/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runGrepSearch } from '../../assistant-server/grep-search-tool';

const { getDatabaseMock, getDatabaseRuntimeDiagnosticsMock, queryMock } = vi.hoisted(() => ({
  getDatabaseMock: vi.fn(),
  getDatabaseRuntimeDiagnosticsMock: vi.fn(),
  queryMock: vi.fn(),
}));

vi.mock('../../db-main', () => ({
  getDatabase: getDatabaseMock,
  getDatabaseRuntimeDiagnostics: getDatabaseRuntimeDiagnosticsMock,
}));

vi.mock('@brainstrike/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/utils/logger')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }),
  };
});

describe('grep search tool', () => {
  function createTursoSearchDb() {
    return markBrainstrikeDbExecutionRuntime(
      {
        capabilities: { liveQuery: false },
        exec: vi.fn(),
        query: queryMock,
        transaction: async <TResult>(
          callback: (tx: { query: typeof queryMock }) => Promise<TResult>
        ) => callback({ query: queryMock }),
      },
      'turso'
    );
  }

  function createReadyTursoDiagnostics() {
    return {
      profileBootstrapReport: {
        checks: [
          {
            id: 'schema.baseline',
            label: 'Turso greenfield schema baseline is applied',
            required: true,
            status: 'passed',
          },
          {
            id: 'search.grep-content-grams',
            label: 'Turso grep content gram index is available',
            required: true,
            status: 'passed',
          },
          {
            id: 'search.ownership',
            label: 'Turso search index ownership is explicit',
            required: true,
            status: 'passed',
          },
        ],
        failure: null,
        phase: 'ready',
        profileId: 'profile-turso',
        ready: true,
        runtime: {
          engine: 'turso',
          host: 'electron-utility',
          persistence: 'filesystem',
        },
        search: {
          indexedSearch: 'available',
          message: 'test search ready',
          ownershipMode: 'split-search-index-store',
        },
        startedAt: '2026-06-29T11:00:00.000Z',
        updatedAt: '2026-06-29T11:00:01.000Z',
      },
    };
  }

  beforeEach(() => {
    getDatabaseMock.mockReset();
    getDatabaseMock.mockResolvedValue({ query: queryMock });
    getDatabaseRuntimeDiagnosticsMock.mockReset();
    getDatabaseRuntimeDiagnosticsMock.mockResolvedValue(createReadyTursoDiagnostics());
    queryMock.mockReset();
  });

  it('uses the bounded Turso grep candidate repository when Turso runtime is selected', async () => {
    getDatabaseMock.mockResolvedValueOnce(createTursoSearchDb());
    queryMock.mockResolvedValue({
      rows: [{ content: 'alpha\nneedle line\nomega', start_line: 10, path: 'src/x.ts' }],
    });

    const result = await runGrepSearch({ pattern: 'needle', outputMode: 'content' }, undefined);

    if (result.outputMode !== 'content') {
      throw new Error('expected content mode result');
    }
    expect(result.matches).toEqual([
      {
        path: 'src/x.ts',
        line: 11,
        lineText: 'needle line',
        before: ['alpha'],
        after: ['omega'],
        source: 'index',
      },
    ]);
    const [sql, params] = queryMock.mock.calls[0] ?? [];
    expect(String(sql)).toContain('file_chunk_content_grams');
    expect(String(sql)).toContain('LIMIT ?');
    expect(String(sql)).not.toContain('$1');
    expect(params).toContain(500);
  });

  it('does not infer Turso runtime from live-query absence alone', async () => {
    getDatabaseMock.mockResolvedValueOnce({
      capabilities: { liveQuery: false },
      query: queryMock,
    });
    queryMock.mockResolvedValue({
      rows: [{ content: 'alpha\nneedle line\nomega', start_line: 10, path: 'src/x.ts' }],
    });

    const result = await runGrepSearch({ pattern: 'needle', outputMode: 'content' }, undefined);

    if (result.outputMode !== 'content') {
      throw new Error('expected content mode result');
    }
    expect(result.matches).toHaveLength(1);
    expect(getDatabaseRuntimeDiagnosticsMock).not.toHaveBeenCalled();
    const [sql] = queryMock.mock.calls[0] ?? [];
    expect(String(sql)).not.toContain('file_chunk_content_grams');
  });

  it('fails closed before querying when Turso bootstrap does not prove the grep content gram index', async () => {
    getDatabaseMock.mockResolvedValueOnce(createTursoSearchDb());
    getDatabaseRuntimeDiagnosticsMock.mockResolvedValueOnce({
      profileBootstrapReport: {
        ...createReadyTursoDiagnostics().profileBootstrapReport,
        checks: [],
      },
    });

    await expect(runGrepSearch({ pattern: 'needle' }, undefined)).rejects.toThrow(
      'brainstrike.grepSearch requires a ready Turso bootstrap report with search.grep-content-grams passed'
    );
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('defaults to files mode: aggregated per-path summaries, no line content', async () => {
    queryMock.mockResolvedValue({
      rows: [
        { content: 'needle one\nplain\nneedle two', start_line: 1, path: 'src/x.ts' },
        { content: 'needle here', start_line: 40, path: 'src/y.ts' },
      ],
    });
    const result = await runGrepSearch({ pattern: 'needle' }, undefined);
    if (result.outputMode !== 'files') {
      throw new Error('expected files mode result');
    }
    expect(result.files).toEqual([
      { path: 'src/x.ts', matchCount: 2, firstLine: 1, source: 'index' },
      { path: 'src/y.ts', matchCount: 1, firstLine: 40, source: 'index' },
    ]);
    expect(result.totalFiles).toBe(2);
    expect(result.totalMatches).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.hint).toBeUndefined();
    // With no open root on disk, the live pass is skipped; results are index-only.
    expect(result.liveEngine).toBe('skipped');
  });

  it('returns path:line matches with context in content mode', async () => {
    queryMock.mockResolvedValue({
      rows: [{ content: 'alpha\nneedle line\nomega', start_line: 10, path: 'src/x.ts' }],
    });
    const result = await runGrepSearch({ pattern: 'needle', outputMode: 'content' }, undefined);
    if (result.outputMode !== 'content') {
      throw new Error('expected content mode result');
    }
    expect(result.matches).toEqual([
      {
        path: 'src/x.ts',
        line: 11,
        lineText: 'needle line',
        before: ['alpha'],
        after: ['omega'],
        source: 'index',
      },
    ]);
    expect(result.truncated).toBe(false);
  });

  it('pages content matches with offset and emits a continuation hint', async () => {
    const lines = Array.from({ length: 6 }, (_, i) => `needle ${i}`).join('\n');
    queryMock.mockResolvedValue({
      rows: [{ content: lines, start_line: 1, path: 'src/x.ts' }],
    });
    const result = await runGrepSearch(
      { pattern: 'needle', outputMode: 'content', contextLines: 0, maxResults: 2, offset: 2 },
      undefined
    );
    if (result.outputMode !== 'content') {
      throw new Error('expected content mode result');
    }
    expect(result.matches.map((m) => m.lineText)).toEqual(['needle 2', 'needle 3']);
    expect(result.offset).toBe(2);
    expect(result.totalMatches).toBe(6);
    expect(result.truncated).toBe(true);
    expect(result.hint).toContain('offset: 4');
  });

  it('self-bounds oversized files-mode output and steers toward content mode', async () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({
      content: 'needle in a haystack of content',
      start_line: 1,
      path: `packages/some-package/src/deeply/nested/dir-${i}/file-with-a-long-name-${i}.ts`,
    }));
    queryMock.mockResolvedValue({ rows });
    const result = await runGrepSearch({ pattern: 'needle' }, undefined);
    if (result.outputMode !== 'files') {
      throw new Error('expected files mode result');
    }
    expect(result.totalFiles).toBe(400);
    expect(result.files.length).toBeLessThan(400);
    expect(result.truncated).toBe(true);
    expect(result.hint).toContain('outputMode');
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(11_000);
  });

  it('advances the offset past a single match too large to fit the budget', async () => {
    // One indexed line larger than the whole output budget (e.g. minified bundle).
    queryMock.mockResolvedValue({
      rows: [
        { content: `${'x'.repeat(15_000)} needle`, start_line: 1, path: 'dist/bundle.min.js' },
        { content: 'small needle line', start_line: 1, path: 'src/ok.ts' },
      ],
    });
    const result = await runGrepSearch(
      { pattern: 'needle', outputMode: 'content', contextLines: 0, maxResults: 1 },
      undefined
    );
    if (result.outputMode !== 'content') {
      throw new Error('expected content mode result');
    }
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(true);
    // The hint must ADVANCE (offset: 1), never repeat the same offset.
    expect(result.hint).toContain('too large');
    expect(result.hint).toContain('offset: 1');
  });

  it('makes the pagination cap terminal instead of repeating an unreachable offset', async () => {
    const lines = Array.from({ length: 2100 }, (_, i) => `needle ${i}`).join('\n');
    queryMock.mockResolvedValue({
      rows: [{ content: lines, start_line: 1, path: 'src/big.ts' }],
    });
    const result = await runGrepSearch(
      { pattern: 'needle', outputMode: 'content', contextLines: 0, offset: 2000 },
      undefined
    );
    if (result.outputMode !== 'content') {
      throw new Error('expected content mode result');
    }
    expect(result.matches).toEqual([]);
    expect(result.totalMatches).toBe(2100);
    expect(result.truncated).toBe(true);
    expect(result.hint).toContain('Pagination cap reached');
    expect(result.hint).not.toContain('offset: 2000');
  });

  it('passes the workspace-index embedding set id from runtimeData', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const runtimeData: Partial<RuntimeData> = {
      workspaceIndexEmbeddingSetId: 'set-1',
      workspaceIndexingEnabled: true,
      workspaceIndexStatusState: 'idle',
    };
    await runGrepSearch({ pattern: 'needle' }, runtimeData as RuntimeData);
    const [sql, params] = queryMock.mock.calls[0] ?? [];
    expect(String(sql)).toContain('embedding_set_id');
    expect(params).toContain('set-1');
  });

  it('surfaces invalid-regex errors without coercion', async () => {
    await expect(runGrepSearch({ pattern: '([', isRegex: true }, undefined)).rejects.toThrow(
      /Invalid regular expression pattern/
    );
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('sanitizes raw repository/db errors to a generic message', async () => {
    queryMock.mockRejectedValue(new Error('relation "file_chunks" does not exist'));
    const promise = runGrepSearch({ pattern: 'needle' }, undefined);
    await expect(promise).rejects.toThrow(/Unable to perform grep search/);
    await expect(promise).rejects.not.toThrow(/file_chunks/);
  });
});

describe('grep search tool multi-root', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  const TWO_ROOTS = {
    workspaceRoots: [
      { rootId: 'db-root-a', displayName: 'ProjectA', path: '/work/ProjectA' },
      { rootId: 'db-root-b', displayName: 'ProjectB', path: '/work/ProjectB' },
    ],
  } as unknown as RuntimeData;

  it('labels file summaries with their root and keeps same-path files in different roots distinct', async () => {
    queryMock.mockResolvedValue({
      rows: [
        {
          content: 'needle',
          start_line: 1,
          path: 'README.md',
          root_id: 'db-root-a',
          display_name: 'ProjectA',
        },
        {
          content: 'needle',
          start_line: 1,
          path: 'README.md',
          root_id: 'db-root-b',
          display_name: 'ProjectB',
        },
      ],
    });
    const result = await runGrepSearch({ pattern: 'needle' }, TWO_ROOTS);
    if (result.outputMode !== 'files') {
      throw new Error('expected files mode result');
    }
    expect(result.files).toHaveLength(2);
    expect(result.files.map((f) => `${f.rootName}/${f.path}`).sort()).toEqual([
      'ProjectA/README.md',
      'ProjectB/README.md',
    ]);
  });

  it('labels content matches with rootId and rootName', async () => {
    queryMock.mockResolvedValue({
      rows: [
        {
          content: 'needle line',
          start_line: 5,
          path: 'src/x.ts',
          root_id: 'db-root-a',
          display_name: 'ProjectA',
        },
      ],
    });
    const result = await runGrepSearch({ pattern: 'needle', outputMode: 'content' }, TWO_ROOTS);
    if (result.outputMode !== 'content') {
      throw new Error('expected content mode result');
    }
    expect(result.matches[0]?.rootName).toBe('ProjectA');
    expect(result.matches[0]?.rootId).toBe('db-root-a');
  });

  it('scopes the query to the resolved root when `root` is provided', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await runGrepSearch({ pattern: 'needle', root: 'ProjectB' }, TWO_ROOTS);
    const [sql, params] = queryMock.mock.calls[0] ?? [];
    expect(String(sql)).toContain('fr.root_id =');
    expect(params).toContain('db-root-b');
  });

  it('errors clearly (and skips the DB) when `root` names a folder that is not open', async () => {
    await expect(runGrepSearch({ pattern: 'needle', root: 'Nope' }, TWO_ROOTS)).rejects.toThrow(
      /no folder "Nope"/i
    );
    expect(queryMock).not.toHaveBeenCalled();
  });
});
