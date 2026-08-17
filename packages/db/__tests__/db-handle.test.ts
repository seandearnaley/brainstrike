import { describe, expect, it, vi } from 'vitest';
import { createDbHandle, type QueryExecutor } from '../src/db-handle.js';
import { getDefaultDbPath } from '../src/default-db-path.js';

type VariadicQuery = (...args: unknown[]) => Promise<{ rows: unknown[] }>;

const BACKGROUND_WORK_OPTIONS = { priority: 'background' } as const;

function makeExecutor(overrides: Partial<QueryExecutor> = {}): QueryExecutor {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    ...overrides,
  };
}

describe('createDbHandle', () => {
  it('passes plain params and native options through untouched', async () => {
    const executor = makeExecutor();
    const handle = createDbHandle(executor);

    await (handle.query as VariadicQuery)('SELECT 1', ['a'], { rowMode: 'array' });

    expect(executor.query).toHaveBeenCalledWith('SELECT 1', ['a'], { rowMode: 'array' });
  });

  it('re-slots work options passed in the params position when options is empty', async () => {
    const executor = makeExecutor();
    const handle = createDbHandle(executor);

    await (handle.query as VariadicQuery)('SELECT 1', BACKGROUND_WORK_OPTIONS);

    expect(executor.query).toHaveBeenCalledWith('SELECT 1', undefined, BACKGROUND_WORK_OPTIONS);
  });

  it('forwards a 4th-slot work options argument variadically (priority proxy stacking)', async () => {
    const executor = makeExecutor();
    const handle = createDbHandle(executor);

    await (handle.query as VariadicQuery)(
      'SELECT 1',
      ['a'],
      { rowMode: 'array' },
      BACKGROUND_WORK_OPTIONS
    );

    expect(executor.query).toHaveBeenCalledWith(
      'SELECT 1',
      ['a'],
      { rowMode: 'array' },
      BACKGROUND_WORK_OPTIONS
    );
  });

  it('only exposes optional executor capabilities that actually exist', () => {
    const handle = createDbHandle(makeExecutor());

    expect(handle.exec).toBeUndefined();
    expect(handle.syncToFs).toBeUndefined();
    expect(handle.transaction).toBeUndefined();
    expect(handle.runTransaction).toBeUndefined();
  });

  it('wraps exec with the same params-slot work-option re-slotting as query', async () => {
    const exec = vi.fn().mockResolvedValue(undefined);
    const handle = createDbHandle(makeExecutor({ exec }));

    await handle.exec?.('VACUUM', BACKGROUND_WORK_OPTIONS as unknown as unknown[]);

    expect(exec).toHaveBeenCalledWith('VACUUM', undefined, BACKGROUND_WORK_OPTIONS);
  });

  it('wraps syncToFs so callers get a void-returning passthrough', async () => {
    const syncToFs = vi.fn().mockResolvedValue('ignored');
    const handle = createDbHandle(makeExecutor({ syncToFs }));

    await expect(handle.syncToFs?.()).resolves.toBeUndefined();
    expect(syncToFs).toHaveBeenCalledTimes(1);
  });

  it('strips the non-serializable abort signal before forwarding chunk insertion', async () => {
    const insertChunksAndEnqueueEmbeddingJobs = vi.fn().mockResolvedValue(undefined);
    const handle = createDbHandle(makeExecutor({ insertChunksAndEnqueueEmbeddingJobs }));

    await handle.insertChunksAndEnqueueEmbeddingJobs?.(
      [],
      'file-1',
      { model: 'test-model', signal: new AbortController().signal },
      BACKGROUND_WORK_OPTIONS
    );

    expect(insertChunksAndEnqueueEmbeddingJobs).toHaveBeenCalledWith(
      [],
      'file-1',
      { model: 'test-model' },
      BACKGROUND_WORK_OPTIONS
    );
  });

  it('forwards runTransaction with the executor as call receiver', async () => {
    const runTransaction = vi.fn().mockResolvedValue({ rows: [{ ok: true }] });
    const handle = createDbHandle(makeExecutor({ runTransaction }));

    const statements = [{ query: 'SELECT 1' }] as Parameters<
      NonNullable<QueryExecutor['runTransaction']>
    >[0];
    const result = await handle.runTransaction?.(statements, 0, BACKGROUND_WORK_OPTIONS);

    expect(runTransaction).toHaveBeenCalledWith(statements, 0, BACKGROUND_WORK_OPTIONS);
    expect(result).toEqual({ rows: [{ ok: true }] });
  });

  it('wraps transaction callbacks in a nested handle over the inner executor', async () => {
    const innerQuery = vi.fn().mockResolvedValue({ rows: [{ ok: true }] });
    const transaction = vi.fn(
      async <T>(fn: (tx: QueryExecutor) => Promise<T>) => await fn({ query: innerQuery })
    );
    const handle = createDbHandle(makeExecutor({ transaction }));

    const result = await handle.transaction?.(async (tx) => await tx.query('SELECT inner'));

    expect(innerQuery).toHaveBeenCalledWith('SELECT inner', undefined, undefined);
    expect(result).toEqual({ rows: [{ ok: true }] });
  });

  it('exposes the raw executor as a non-enumerable escape hatch', () => {
    const executor = makeExecutor();
    const handle = createDbHandle(executor);

    expect((handle as { raw?: unknown }).raw).toBe(executor);
    expect(Object.keys(handle)).not.toContain('raw');
  });
});

describe('getDefaultDbPath without Node builtins', () => {
  it('throws loudly when process.getBuiltinModule is unavailable', () => {
    const spy = vi
      .spyOn(
        process as NodeJS.Process & { getBuiltinModule: (name: string) => unknown },
        'getBuiltinModule'
      )
      .mockReturnValue(undefined);
    try {
      expect(() => getDefaultDbPath()).toThrow('Node builtin module is unavailable: node:os');
    } finally {
      spy.mockRestore();
    }
  });
});
