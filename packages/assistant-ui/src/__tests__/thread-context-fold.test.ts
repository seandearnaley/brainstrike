import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import {
  diffPromptToolCallWindow,
  type PromptToolCall,
} from '@brainstrike/assistant-contract/context-breakdown';
import { formatGrepProjectionPageRange } from '@brainstrike/assistant-contract/context-provenance';
import { describe, expect, it } from 'vitest';
import type { CommittedAssistantLogRow } from '../committed-assistant-log-projection';
import {
  displayedBranchRunIds,
  ThreadContextFold,
  type ThreadContextSnapshot,
  threadContextAt,
} from '../thread-context-fold';
import recording from './fixtures/committed-luna-long-tool-run.json';

const threadId = 'thread-1';
const rootId = 'root-1';

/** Committed rows for one thread, numbered in order. */
function log() {
  const rows: CommittedAssistantLogRow[] = [];
  const add = (event: Record<string, unknown>) => {
    rows.push({ event, seq: rows.length + 1, threadId });
  };
  const windows = new Map<string, ReadonlyMap<string, PromptToolCall> | undefined>();
  return {
    add,
    /** A provider request that carried exactly `calls`, as the host commits its window. */
    request(runId: string, calls: readonly PromptToolCall[] | null) {
      if (calls === null) {
        add({ breakdown: {}, runId, type: 'provider.request.prepared' });
        return;
      }
      const toolCallWindow = diffPromptToolCallWindow(windows.get(runId), calls);
      windows.set(runId, new Map(calls.map((call) => [call.toolCallId, call])));
      add({ runId, toolCallWindow, type: 'provider.request.prepared' });
    },
    rows,
    run(runId: string, prompt = `prompt ${runId}`) {
      add({ prompt, runId, type: 'run.started' });
    },
    /** A tool call and its raw result, then the model step that carried its projection. */
    tool(
      runId: string,
      toolCallId: string,
      toolCatalogId: string,
      output: unknown,
      modelText?: string
    ) {
      add({ input: {}, runId, toolCallId, toolCatalogId, type: 'effect.started' });
      add({ output, runId, toolCallId, type: 'effect.finished' });
      add({
        messages: [
          {
            content: [
              {
                output: { type: 'text', value: modelText ?? JSON.stringify(output) },
                toolCallId,
                toolName: toolCatalogId,
                type: 'tool-result',
              },
            ],
            role: 'tool',
          },
        ],
        runId,
        type: 'model.step',
      });
    },
  };
}

const sent = (
  toolCallId: string,
  outputTokens = 100,
  output: PromptToolCall['output'] = 'full'
): PromptToolCall => ({
  inputTokens: 5,
  output,
  outputTokens,
  toolCallId,
  toolName: 'brainstrike.readWorkspaceFile',
});

const read = (path: string, startLine: number, endLine: number, extra = {}) => ({
  approxOutputTokens: 10,
  content: Array.from(
    { length: endLine - startLine + 1 },
    (_, index) => `${startLine + index}: line ${startLine + index}`
  ).join('\n'),
  endLine,
  nextCursor: null,
  path,
  rootId,
  startLine,
  totalLines: 400,
  truncated: false,
  ...extra,
});

function fold(rows: readonly CommittedAssistantLogRow[]): ThreadContextSnapshot {
  return new ThreadContextFold().accept(rows);
}

const linear = (snapshot: ThreadContextSnapshot) => [...snapshot.runs.keys()];

describe('ThreadContextFold spans', () => {
  it('maps every read of a recorded host run, and gives an unmeasured receipt an unknown state', () => {
    const snapshot = fold(recording as CommittedAssistantLogRow[]);
    const calls = [...snapshot.calls.values()];
    const reads = calls.filter((call) => call.toolName === 'brainstrike.readWorkspaceFile');
    expect(reads).toHaveLength(12);
    expect(reads[0]?.spans).toEqual([
      {
        deliveredLines: ['export const module1 = 1;', ''],
        endLine: 2,
        kind: 'read',
        path: 'src/module-1.ts',
        rootId: '6df421ed-a6a2-478c-b436-09d2e0c02ee9',
        startLine: 1,
      },
    ]);
    // Paths-only tools deliver no file content.
    for (const name of ['brainstrike.globWorkspace', 'brainstrike.grepSearch']) {
      expect(calls.find((call) => call.toolName === name)).toMatchObject({
        spans: [],
        status: 'done',
      });
    }
    // Recorded before requests committed windows: unknown, never a fabricated zero.
    const view = threadContextAt(snapshot, linear(snapshot));
    expect(view.calls.every((call) => call.state === 'unknown')).toBe(true);
    expect(view.calls.every((call) => call.windowTokens === null)).toBe(true);
  });

  it('reads each cursor page, a truncated page and a repeat as what was delivered', () => {
    const l = log();
    l.run('r1');
    l.tool(
      'r1',
      'p1',
      'brainstrike.readWorkspaceFile',
      read('src/a.ts', 1, 220, { truncated: true })
    );
    l.tool('r1', 'p2', 'brainstrike.readWorkspaceFile', read('src/a.ts', 221, 406));
    l.tool('r1', 'p3', 'brainstrike.readWorkspaceFile', read('src/a.ts', 1, 3, { dedup: true }));
    const { calls } = fold(l.rows);
    expect(calls.get('p1')?.spans[0]).toMatchObject({ endLine: 220, startLine: 1 });
    expect(calls.get('p2')?.spans[0]).toMatchObject({ endLine: 406, startLine: 221 });
    expect(calls.get('p3')?.spans[0]).toMatchObject({ repeat: true });
  });

  it('counts only the grep matches its delivered page kept', () => {
    const l = log();
    l.run('r1');
    const matches = Array.from({ length: 5 }, (_, index) => ({
      after: ['after'],
      before: ['before'],
      line: 10 * (index + 1),
      lineText: `match ${index}`,
      path: `src/m${index}.ts`,
      rootId,
    }));
    const header = `grep content ${formatGrepProjectionPageRange({
      kept: 2,
      lowerBound: false,
      offset: 0,
      total: 5,
    })}`;
    l.tool(
      'r1',
      'g1',
      'brainstrike.grepSearch',
      { matches, offset: 0, outputMode: 'content' },
      `${header}\nsrc/m0.ts\n  10: match 0`
    );
    const spans = fold(l.rows).calls.get('g1')?.spans;
    expect(spans).toEqual([
      {
        deliveredLines: ['before', 'match 0', 'after'],
        endLine: 11,
        kind: 'grep',
        path: 'src/m0.ts',
        rootId,
        startLine: 9,
      },
      expect.objectContaining({ endLine: 21, path: 'src/m1.ts', startLine: 19 }),
    ]);
  });

  it('shows an unreadable grep page as unmapped rather than guessing', () => {
    const l = log();
    l.run('r1');
    l.tool(
      'r1',
      'g1',
      'brainstrike.grepSearch',
      { matches: [], offset: 0, outputMode: 'content' },
      '[pruned old tool result]'
    );
    expect(fold(l.rows).calls.get('g1')).toMatchObject({
      spans: [],
      unmapped: 'The delivered grep page header is unreadable.',
    });
  });

  it('marks semantic chunks partial when their text was cut or an excerpt', () => {
    const l = log();
    l.run('r1');
    const chunk = (id: string, start: number) => ({
      filePath: 'src/s.ts',
      id,
      lineRange: { end: start + 9, start },
      metadata: { rootId },
    });
    l.tool('r1', 'q1', 'brainstrike.queryEmbeddingSpace', {
      chunkContentIncludedInContext: true,
      chunks: [chunk('c1', 1)],
    });
    l.tool(
      'r1',
      'q2',
      'brainstrike.queryEmbeddingSpace',
      { chunkContentIncludedInContext: true, chunks: [chunk('c2', 11)] },
      'semantic | ...\nprojection_omitted_context_chars=120'
    );
    l.tool(
      'r1',
      'h1',
      'brainstrike.hybridSearch',
      {
        results: [
          { filePath: 'src/h.ts', id: 'c3', rootName: 'repo' },
          { filePath: 'src/i.ts', id: 'c4', rootName: 'repo' },
        ],
      },
      'hybrid | set=s | shown=1/2 | truncated=false'
    );
    const { calls } = fold(l.rows);
    expect(calls.get('q1')?.spans).toEqual([
      { chunkId: 'c1', endLine: 10, kind: 'semantic', path: 'src/s.ts', rootId, startLine: 1 },
    ]);
    expect(calls.get('q2')?.spans[0]).toMatchObject({ chunkId: 'c2', partial: true });
    expect(calls.get('h1')?.spans).toEqual([
      { chunkId: 'c3', kind: 'semantic', partial: true, path: 'src/h.ts', rootName: 'repo' },
    ]);
  });

  it('draws an edit at its written lines, a whole-file write, and no span for a failed call', () => {
    const l = log();
    l.run('r1');
    l.tool('r1', 'e1', 'brainstrike.stringReplaceWorkspaceFile', {
      editedLines: { endLine: 318, startLine: 301 },
      path: 'src/a.ts',
      replaced: true,
      rootId,
    });
    l.tool('r1', 'w1', 'brainstrike.writeWorkspaceFile', {
      bytesWritten: 9,
      path: 'src/n.ts',
      rootId,
    });
    l.add({
      input: {},
      runId: 'r1',
      toolCallId: 'x1',
      toolCatalogId: 'brainstrike.readWorkspaceFile',
      type: 'effect.started',
    });
    l.add({
      chunk: { error: 'denied', toolCallId: 'x1', type: 'tool-error' },
      runId: 'r1',
      type: 'stream.chunk',
    });
    const { calls } = fold(l.rows);
    expect(calls.get('e1')?.spans).toEqual([
      { endLine: 318, kind: 'edit', path: 'src/a.ts', rootId, startLine: 301 },
    ]);
    expect(calls.get('w1')?.spans).toEqual([
      { kind: 'edit', path: 'src/n.ts', rootId, wholeFile: true },
    ]);
    expect(calls.get('x1')).toMatchObject({ spans: [], status: 'failed' });
  });

  it('shows a malformed result as unmapped with its reason', () => {
    const l = log();
    l.run('r1');
    l.tool('r1', 'm1', 'brainstrike.readWorkspaceFile', { path: 'src/a.ts' });
    expect(fold(l.rows).calls.get('m1')).toMatchObject({
      spans: [],
      unmapped: 'The read result has an unexpected shape.',
    });
  });

  it('pins each @file the prompt attached, except one the run could not read', () => {
    const l = log();
    l.run('r1', 'see :file[a.md]{name=root-1::docs/a.md} and :file[b.md]{name=root-1::docs/b.md}');
    l.add({
      files: [{ failure: INTERNAL_FAULT, path: 'docs/b.md', rootId }],
      runId: 'r1',
      type: 'references.unavailable',
    });
    const pins = [...fold(l.rows).calls.values()].filter((call) => call.attachment);
    expect(pins.map((pin) => [pin.status, pin.spans])).toEqual([
      ['done', [{ kind: 'pinned', path: 'docs/a.md', rootId, wholeFile: true }]],
      ['failed', []],
    ]);
  });
});

describe('threadContextAt window states', () => {
  it('follows the host window: in window, collapsed to a marker, compacted, then gone', () => {
    const l = log();
    l.run('r1');
    l.tool('r1', 'a', 'brainstrike.readWorkspaceFile', read('src/a.ts', 1, 50));
    l.request('r1', [sent('a', 500)]);
    l.run('r2');
    l.tool('r2', 'b', 'brainstrike.readWorkspaceFile', read('src/b.ts', 1, 20));
    // r2's later request: `a` was superseded and goes out as its marker.
    l.request('r2', [sent('a', 500), sent('b', 200)]);
    l.request('r2', [sent('a', 9, 'marker'), sent('b', 200)]);
    l.run('r3');
    l.add({
      compactedRunIds: ['r1'],
      kind: 'deterministic',
      reason: 'pre-request',
      runId: 'r3',
      summary: 's',
      type: 'context.compacted',
    });
    l.request('r3', [sent('b', 200)]);
    const snapshot = fold(l.rows);
    const branch = linear(snapshot);

    const stateAt = (turn: number) =>
      Object.fromEntries(
        threadContextAt(snapshot, branch, turn).calls.map((c) => [
          c.call.toolCallId,
          [c.state, c.windowTokens, c.deliveredTokens],
        ])
      );
    expect(stateAt(1)).toEqual({ a: ['in-window', 505, 505] });
    expect(stateAt(2)).toEqual({ a: ['collapsed', 14, 505], b: ['in-window', 205, 205] });
    expect(stateAt(3)).toEqual({ a: ['compacted', 0, 505], b: ['in-window', 205, 205] });
  });

  it('keeps an attachment in the window for its own run only', () => {
    const l = log();
    l.run('r1', ':file[a.md]{name=root-1::docs/a.md}');
    l.request('r1', []);
    l.run('r2');
    l.request('r2', []);
    const snapshot = fold(l.rows);
    const pinAt = (turn: number) =>
      threadContextAt(snapshot, linear(snapshot), turn).calls.find((c) => c.call.attachment)?.state;
    expect(pinAt(1)).toBe('in-window');
    expect(pinAt(2)).toBe('dropped');
  });

  it('shows only the displayed branch, from the projection head', () => {
    const l = log();
    l.run('r1');
    l.tool('r1', 'a', 'brainstrike.readWorkspaceFile', read('src/a.ts', 1, 5));
    l.request('r1', [sent('a')]);
    l.run('r2a');
    l.tool('r2a', 'b', 'brainstrike.readWorkspaceFile', read('src/b.ts', 1, 5));
    l.run('r2b');
    l.tool('r2b', 'c', 'brainstrike.readWorkspaceFile', read('src/c.ts', 1, 5));
    l.request('r2b', [sent('a'), sent('c')]);
    const snapshot = fold(l.rows);
    const message = (id: string) => ({ id }) as never;
    const branch = displayedBranchRunIds(
      {
        headId: 'r2b',
        messages: [
          { message: message('u1'), parentId: null },
          { message: message('r1'), parentId: 'u1' },
          { message: message('u2a'), parentId: 'r1' },
          { message: message('r2a'), parentId: 'u2a' },
          { message: message('u2b'), parentId: 'r1' },
          { message: message('r2b'), parentId: 'u2b' },
        ],
      },
      snapshot.runs
    );
    expect(branch).toEqual(['r1', 'r2b']);
    expect(threadContextAt(snapshot, branch).calls.map((c) => c.call.toolCallId)).toEqual([
      'a',
      'c',
    ]);
  });

  it('marks a call the latest window no longer carries, without a compaction, as dropped', () => {
    const l = log();
    l.run('r1');
    l.tool('r1', 'a', 'brainstrike.readWorkspaceFile', read('src/a.ts', 1, 5));
    l.request('r1', [sent('a')]);
    l.run('r2');
    l.request('r2', []);
    const snapshot = fold(l.rows);
    expect(threadContextAt(snapshot, linear(snapshot)).calls[0]?.state).toBe('dropped');
  });

  it('reports unknown for a turn whose request recorded no window', () => {
    const l = log();
    l.run('r1');
    l.tool('r1', 'a', 'brainstrike.readWorkspaceFile', read('src/a.ts', 1, 5));
    l.request('r1', null);
    const snapshot = fold(l.rows);
    expect(threadContextAt(snapshot, linear(snapshot)).calls[0]).toMatchObject({
      deliveredTokens: null,
      state: 'unknown',
      windowTokens: null,
    });
  });
});

describe('ThreadContextFold incremental folding', () => {
  it('folds each row once and returns the same snapshot when nothing changed', () => {
    const l = log();
    l.run('r1');
    const f = new ThreadContextFold();
    const first = f.accept(l.rows);
    expect(f.accept(l.rows)).toBe(first);
    l.tool('r1', 'a', 'brainstrike.readWorkspaceFile', read('src/a.ts', 1, 5));
    const next = f.accept(l.rows);
    expect(next).not.toBe(first);
    expect(next.calls.get('a')?.spans).toHaveLength(1);
  });

  it('folds a 5,000-row thread quickly', () => {
    const l = log();
    for (let run = 0; run < 50; run += 1) {
      const runId = `r${run}`;
      l.run(runId);
      const calls: PromptToolCall[] = [];
      for (let index = 0; index < 25; index += 1) {
        const id = `${runId}-${index}`;
        l.tool(runId, id, 'brainstrike.readWorkspaceFile', read(`src/f${index}.ts`, 1, 40));
        calls.push(sent(id));
      }
      l.request(runId, calls);
    }
    expect(l.rows.length).toBeGreaterThanOrEqual(3800);
    const f = new ThreadContextFold();
    const started = performance.now();
    // Arrive in commit batches, as a live subscription delivers them.
    for (let end = 100; end <= l.rows.length + 100; end += 100) {
      f.accept(l.rows.slice(0, end));
    }
    const snapshot = f.accept(l.rows);
    threadContextAt(snapshot, linear(snapshot));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(snapshot.calls.size).toBe(1250);
  });
});
