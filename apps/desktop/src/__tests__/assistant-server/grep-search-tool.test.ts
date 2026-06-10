import type { RuntimeData } from '@brainstrike/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runGrepSearch } from '../../assistant-server/grep-search-tool';

const queryMock = vi.fn();

vi.mock('../../db-main', () => ({
  getDatabase: vi.fn(async () => ({ query: queryMock })),
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
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('returns path:line matches for a literal pattern', async () => {
    queryMock.mockResolvedValue({
      rows: [{ content: 'alpha\nneedle line\nomega', start_line: 10, path: 'src/x.ts' }],
    });
    const result = await runGrepSearch({ pattern: 'needle' }, undefined);
    expect(result.matches).toEqual([
      {
        path: 'src/x.ts',
        line: 11,
        lineText: 'needle line',
        before: ['alpha'],
        after: ['omega'],
      },
    ]);
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
