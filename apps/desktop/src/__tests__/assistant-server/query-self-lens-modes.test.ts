/**
 * Lens modes on `brainstrike.querySelf` (BST-921): discovery lists valid AND
 * invalid entries; invocation resolves the lens by id, coerces positional
 * string values by DECLARED types, and executes through the REAL
 * AgentSqlService with true bind parameters — the fake engine below captures
 * the params array to prove no value is ever interpolated into the SQL text.
 */

import { ToolInputError } from '@brainstrike/assistant-contract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserLensScanResult } from '../../assistant-server/lens-loader';

const getDatabaseMock = vi.fn();

vi.mock('../../db-main', () => ({
  getDatabase: () => getDatabaseMock(),
}));

vi.mock('@brainstrike/logging', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/logging')>();
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

const { runQuerySelf } = await import('../../assistant-server/query-self-tool');

interface CapturedCall {
  params: readonly unknown[] | undefined;
  sql: string;
}

/** Fake PGlite transaction surface that CAPTURES (sql, params) per call. The
 * real AgentSqlService runs against it, so the preamble, admission, and
 * param threading under test are production code paths. */
function fakeDatabase(calls: CapturedCall[], rows: unknown[][]) {
  return {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      await fn({
        exec: async () => await Promise.resolve(undefined),
        query: async (sql: string, params?: readonly unknown[]) => {
          calls.push({ params, sql });
          if (sql.startsWith('EXPLAIN')) {
            return { rows: [{ 'QUERY PLAN': [{ Plan: { 'Total Cost': 1.5 } }] }] };
          }
          return { fields: [{ name: 'path' }], rows };
        },
      }),
  };
}

const LENS_SCAN: UserLensScanResult = {
  entries: [
    {
      absPath: '/work/a/.brainstrike/lenses/app-test-lens.sql',
      fileName: 'app-test-lens.sql',
      lens: {
        description: 'Caller-graph hybrid retrieval',
        id: 'app-test-lens',
        params: [
          { description: 'Seed symbol', name: 'symbol', type: 'text' },
          { description: 'Max depth', name: 'depth', type: 'integer' },
        ],
        sql: 'SELECT path FROM t WHERE name = $1 AND depth < $2',
        target: 'app',
      },
      sourceRootId: 'root-a',
      status: 'ok',
    },
    {
      absPath: '/work/a/.brainstrike/lenses/broken.sql',
      error: 'Missing required "-- description:" header line.',
      fileName: 'broken.sql',
      sourceRootId: 'root-a',
      status: 'invalid',
    },
    {
      absPath: '/home/user/.brainstrike/lenses/app-test-lens.sql',
      fileName: 'app-test-lens.sql',
      shadowedBy: {
        absPath: '/work/a/.brainstrike/lenses/app-test-lens.sql',
        sourceRootId: 'root-a',
      },
      status: 'shadowed',
    },
  ],
  incompleteDirs: [],
  lenses: [
    {
      description: 'Caller-graph hybrid retrieval',
      id: 'app-test-lens',
      params: [
        { description: 'Seed symbol', name: 'symbol', type: 'text' },
        { description: 'Max depth', name: 'depth', type: 'integer' },
      ],
      sql: 'SELECT path FROM t WHERE name = $1 AND depth < $2',
      target: 'app',
    },
  ],
};

beforeEach(() => {
  getDatabaseMock.mockReset();
});

describe('mode=listLenses', () => {
  it('lists valid lenses AND invalid entries with their errors', async () => {
    const result = await runQuerySelf({ mode: 'listLenses', target: 'app' }, undefined, {
      scanLenses: () => LENS_SCAN,
    });
    expect(result.kind).toBe('lenses');
    if (result.kind !== 'lenses') {
      throw new Error('expected lenses');
    }
    expect(result.lenses).toEqual([
      {
        description: 'Caller-graph hybrid retrieval',
        id: 'app-test-lens',
        params: [
          { description: 'Seed symbol', name: 'symbol', type: 'text' },
          { description: 'Max depth', name: 'depth', type: 'integer' },
        ],
        source: 'root-a',
        target: 'app',
      },
    ]);
    expect(result.invalid).toEqual([
      {
        error: 'Missing required "-- description:" header line.',
        fileName: 'broken.sql',
        source: 'root-a',
      },
    ]);
    // Shadowing is visible and names the file that WON.
    expect(result.shadowed).toEqual([
      {
        fileName: 'app-test-lens.sql',
        shadowedByPath: '/work/a/.brainstrike/lenses/app-test-lens.sql',
        source: 'global',
      },
    ]);
    // Discovery is a pure directory scan; the database is never touched.
    expect(getDatabaseMock).not.toHaveBeenCalled();
  });
});

describe('mode=lens', () => {
  it('executes the lens SQL with coerced BIND params — never interpolation', async () => {
    const calls: CapturedCall[] = [];
    getDatabaseMock.mockResolvedValue(fakeDatabase(calls, [['src/a.ts']]));

    const result = await runQuerySelf(
      { lens: 'app-test-lens', mode: 'lens', target: 'app', values: ['startWorker', '5'] },
      undefined,
      { scanLenses: () => LENS_SCAN }
    );

    expect(result.kind).toBe('rows');
    if (result.kind !== 'rows') {
      throw new Error('expected rows');
    }
    expect(result.rows).toEqual([{ cells: ['src/a.ts'] }]);

    const execution = calls.find((call) => !call.sql.startsWith('EXPLAIN'));
    expect(execution?.sql).toContain('WHERE name = $1 AND depth < $2');
    expect(execution?.sql).not.toContain('startWorker');
    // integer param arrives as a NUMBER (declared type), text as string.
    expect(execution?.params).toEqual(['startWorker', 5]);

    // Admission planned with the SAME binds.
    const admission = calls.find((call) => call.sql.startsWith('EXPLAIN'));
    expect(admission?.params).toEqual(['startWorker', 5]);
  });

  it('invoking a RESERVED-but-invalid lens id surfaces its parse error', async () => {
    // A broken project file reserves its id; the honest answer is the parse
    // error, not "unknown lens" (and never a same-named global fallback).
    await expect(
      runQuerySelf({ lens: 'broken', mode: 'lens', target: 'app', values: [] }, undefined, {
        scanLenses: () => LENS_SCAN,
      })
    ).rejects.toThrow(/exists but is invalid.*description/i);
  });

  it('rejects an unknown lens id naming the available ones', async () => {
    await expect(
      runQuerySelf({ lens: 'nope', mode: 'lens', target: 'app', values: [] }, undefined, {
        scanLenses: () => LENS_SCAN,
      })
    ).rejects.toThrow(/Unknown lens "nope".*app-test-lens/);
  });

  it('rejects a missing lens id with the listLenses pointer', async () => {
    await expect(
      runQuerySelf({ mode: 'lens', target: 'app' }, undefined, { scanLenses: () => LENS_SCAN })
    ).rejects.toThrow(/listLenses/);
  });

  it('rejects a value that fails its declared type, naming the param', async () => {
    await expect(
      runQuerySelf(
        {
          lens: 'app-test-lens',
          mode: 'lens',
          target: 'app',
          values: ['startWorker', 'not-a-number'],
        },
        undefined,
        { scanLenses: () => LENS_SCAN }
      )
    ).rejects.toThrow(/depth/);
  });

  it('rejects a value-count mismatch as a ToolInputError', async () => {
    await expect(
      runQuerySelf(
        { lens: 'app-test-lens', mode: 'lens', target: 'app', values: ['only-one'] },
        undefined,
        {
          scanLenses: () => LENS_SCAN,
        }
      )
    ).rejects.toThrow(ToolInputError);
  });
});
