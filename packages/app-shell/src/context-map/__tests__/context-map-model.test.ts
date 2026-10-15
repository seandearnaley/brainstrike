import type {
  ContextCall,
  ContextCallAtTurn,
  ContextCallState,
  ContextSpan,
} from '@brainstrike/assistant-ui/thread-context-fold';
import { describe, expect, it } from 'vitest';
import { chunkCells, contextFileRows, contextMapTotals, lineBands } from '../context-map-model';

const rootId = 'root-1';

function at(
  toolCallId: string,
  spans: ContextSpan[],
  options: {
    delivered?: number | null;
    state?: ContextCallState;
    turn?: number;
    window?: number | null;
  } = {}
): ContextCallAtTurn {
  const call: ContextCall = {
    attachment: false,
    runId: `run-${options.turn ?? 1}`,
    spans,
    status: 'done',
    toolCallId,
    toolName: 'brainstrike.readWorkspaceFile',
  };
  const state = options.state ?? 'in-window';
  return {
    call,
    deliveredTokens: options.delivered === undefined ? 100 : options.delivered,
    state,
    turn: options.turn ?? 1,
    windowTokens: options.window === undefined ? (state === 'in-window' ? 100 : 0) : options.window,
  };
}

const read = (path: string, startLine: number, endLine: number): ContextSpan => ({
  endLine,
  kind: 'read',
  path,
  rootId,
  startLine,
});

const view = (calls: ContextCallAtTurn[]) => ({ branch: [], calls, turn: 1 });

describe('contextFileRows', () => {
  it('groups spans by file and spreads each call over its spans by lines', () => {
    const grep: ContextCallAtTurn = {
      ...at('g', [read('a.ts', 1, 3), read('b.ts', 10, 18)], { delivered: 120, window: 120 }),
    };
    const rows = contextFileRows([at('r', [read('a.ts', 1, 100)]), grep], 'window');
    expect(rows.map((row) => [row.path, row.windowTokens, row.deliveredTokens])).toEqual([
      ['a.ts', 100 + 30, 100 + 30],
      ['b.ts', 90, 90],
    ]);
  });

  it('keeps an unrecorded window unknown for the file instead of summing a zero', () => {
    const rows = contextFileRows(
      [at('r', [read('a.ts', 1, 5)], { delivered: null, state: 'unknown', window: null })],
      'window'
    );
    expect(rows[0]).toMatchObject({ deliveredTokens: null, gone: false, windowTokens: null });
  });

  it('marks an edit to lines no earlier span delivered', () => {
    const edit = (start: number, end: number): ContextSpan => ({
      endLine: end,
      kind: 'edit',
      path: 'a.ts',
      rootId,
      startLine: start,
    });
    const coveredEdit = contextFileRows(
      [at('r', [read('a.ts', 1, 50)]), at('e', [edit(10, 20)], { turn: 2 })],
      'window'
    );
    expect(coveredEdit[0]?.editedWithoutRead).toBe(false);
    const blindEdit = contextFileRows(
      [at('r', [read('a.ts', 1, 5)]), at('e', [edit(10, 20)], { turn: 2 })],
      'window'
    );
    expect(blindEdit[0]?.editedWithoutRead).toBe(true);
  });

  it('marks a file gone when none of its spans is still in the window', () => {
    const rows = contextFileRows([at('r', [read('a.ts', 1, 5)], { state: 'compacted' })], 'window');
    expect(rows[0]?.gone).toBe(true);
    expect(rows[0]?.windowTokens).toBe(0);
  });
});

describe('chunkCells', () => {
  const chunks = [
    { chunkId: 'c1', contentHash: 'h', endLine: 10, startLine: 1, tokenCount: 50 },
    { chunkId: 'c2', contentHash: 'h', endLine: 20, startLine: 11, tokenCount: 50 },
    { chunkId: 'c3', contentHash: 'h', endLine: 30, startLine: 21, tokenCount: 50 },
  ];

  it('fills each chunk by the share of its lines delivered, colored by the strongest kind', () => {
    const rows = contextFileRows(
      [
        at('r', [read('a.ts', 1, 5)]),
        at('e', [{ endLine: 4, kind: 'edit', path: 'a.ts', rootId, startLine: 3 }], { turn: 2 }),
      ],
      'window'
    );
    const cells = chunkCells(chunks, rows[0]?.spans ?? [], 'window');
    expect(cells.map((cell) => [cell.kind, cell.coverage, cell.gone])).toEqual([
      ['edit', 0.5, false],
      [null, 0, false],
      [null, 0, false],
    ]);
  });

  it('draws only live spans in window mode, and departed ones hatched when nothing live remains', () => {
    const rows = contextFileRows(
      [
        at('old', [read('a.ts', 1, 20)], { state: 'compacted' }),
        at('new', [read('a.ts', 11, 15)], { turn: 2 }),
      ],
      'window'
    );
    const spans = rows[0]?.spans ?? [];
    const windowCells = chunkCells(chunks, spans, 'window');
    expect(windowCells.map((cell) => [cell.coverage, cell.gone])).toEqual([
      [1, true],
      [0.5, false],
      [0, false],
    ]);
    // Everything mode draws every span that reached the chunk.
    expect(chunkCells(chunks, spans, 'all').map((cell) => cell.coverage)).toEqual([1, 1, 0]);
  });

  it('fills a chunk named only by id, and marks it partial', () => {
    const rows = contextFileRows(
      [at('s', [{ chunkId: 'c3', kind: 'semantic', partial: true, path: 'a.ts', rootId }])],
      'window'
    );
    const cell = chunkCells(chunks, rows[0]?.spans ?? [], 'window')[2];
    expect(cell).toMatchObject({ coverage: 1, kind: 'semantic', partial: true });
  });
});

describe('lineBands and totals', () => {
  it('splits an unindexed file into equal line bands', () => {
    expect(lineBands(20, 4).map((band) => [band.startLine, band.endLine])).toEqual([
      [1, 5],
      [6, 10],
      [11, 15],
      [16, 20],
    ]);
    expect(lineBands(2, 8)).toHaveLength(2);
  });

  it('counts tokens delivered more than once and calls without file lines', () => {
    const calls = [
      at('r1', [read('a.ts', 1, 10)], { delivered: 100 }),
      at('r2', [read('a.ts', 1, 10)], { delivered: 100, turn: 2 }),
      {
        ...at('x', [], { delivered: null, window: null }),
        call: { ...at('x', []).call, toolName: 'brainstrike.executeCommand' },
      },
    ];
    const rows = contextFileRows(calls, 'all');
    const totals = contextMapTotals(view(calls), rows);
    expect(totals).toMatchObject({ otherCalls: 1, rereadTokens: 100, unmappedCalls: 0 });
  });
});
