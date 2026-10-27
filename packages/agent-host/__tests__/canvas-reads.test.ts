import { describe, expect, it } from 'vitest';
import { hostCanvases } from '../src/core-canvases.js';
import type { Json } from '../src/json-value.js';
import { canvasStateKey, type HostCanvasVersion } from '../src/protocol.js';
import { HostToolRecords } from '../src/tool-records.js';

function version(
  canvasId: string,
  next: number,
  createdAt: string,
  title = `Canvas ${canvasId}`
): HostCanvasVersion {
  return {
    canvasId,
    createdAt,
    createdBy: 'assistant',
    html: `<h1>${title} v${next}</h1>`,
    title,
    version: next,
  };
}

function fixture() {
  const records = new HostToolRecords();
  const threads = new Set(['root', 'child', 'other']);
  const parents = new Map([['child', 'root']]);
  const canvases = hostCanvases(
    records,
    { rootThread: (threadId) => parents.get(threadId) ?? threadId },
    threads
  );
  let seq = 0;
  const commit = (threadId: string, key: string, value: Json) => {
    seq += 1;
    records.fold({
      event: {
        key,
        runId: `run-${seq}`,
        toolCallId: `call-${seq}`,
        type: 'tool.state.updated',
        value,
      },
      seq,
      threadId,
    });
  };
  const write = (threadId: string, canvas: HostCanvasVersion) =>
    commit(threadId, canvasStateKey(canvas.canvasId), canvas);
  return { canvases, commit, records, threads, write };
}

describe('host canvas reads (the Artifacts gallery)', () => {
  it("lists every thread's canvases at their latest version, newest first, with their root thread", () => {
    const { canvases, commit, write } = fixture();
    write('root', version('plan', 1, '2026-10-27T10:00:00.000Z', 'Plan'));
    write('child', version('chart', 1, '2026-10-27T11:00:00.000Z', 'Chart'));
    write('root', version('plan', 2, '2026-10-27T12:00:00.000Z', 'Plan, revised'));
    write('other', version('notes', 1, '2026-10-27T09:00:00.000Z', 'Notes'));
    // Another tool's state is not an artifact.
    commit('root', 'brainstrike.manageTasks/list', ['task']);

    expect(canvases.list().canvases).toEqual([
      {
        canvasId: 'plan',
        createdBy: 'assistant',
        rootThreadId: 'root',
        threadId: 'root',
        title: 'Plan, revised',
        updatedAt: '2026-10-27T12:00:00.000Z',
        version: 2,
      },
      {
        canvasId: 'chart',
        createdBy: 'assistant',
        rootThreadId: 'root',
        threadId: 'child',
        title: 'Chart',
        updatedAt: '2026-10-27T11:00:00.000Z',
        version: 1,
      },
      {
        canvasId: 'notes',
        createdBy: 'assistant',
        rootThreadId: 'other',
        threadId: 'other',
        title: 'Notes',
        updatedAt: '2026-10-27T09:00:00.000Z',
        version: 1,
      },
    ]);
  });

  it("drops a deleted thread's canvases with it", () => {
    const { canvases, records, threads, write } = fixture();
    write('root', version('plan', 1, '2026-10-27T10:00:00.000Z'));
    write('other', version('notes', 1, '2026-10-27T09:00:00.000Z'));

    threads.delete('other');
    records.forgetThread('other', {});

    expect(canvases.list().canvases.map((canvas) => canvas.canvasId)).toEqual(['plan']);
    expect(() => canvases.read({ canvasId: 'notes', threadId: 'other' })).toThrow('Unknown thread');
  });

  it('reads one canvas with its document, and null for a canvas the thread does not hold', () => {
    const { canvases, write } = fixture();
    const latest = version('plan', 2, '2026-10-27T12:00:00.000Z');
    write('root', version('plan', 1, '2026-10-27T10:00:00.000Z'));
    write('root', latest);

    expect(canvases.read({ canvasId: 'plan', threadId: 'root' })).toEqual({ canvas: latest });
    expect(canvases.read({ canvasId: 'plan', threadId: 'other' })).toEqual({ canvas: null });
  });

  it('fails visibly on a committed value that is not a canvas version', () => {
    const { canvases, commit } = fixture();
    commit('root', canvasStateKey('broken'), { title: 'no html' });

    expect(() => canvases.list()).toThrow();
    expect(() => canvases.read({ canvasId: 'broken', threadId: 'root' })).toThrow();

    // A version filed under another canvas's key is corrupt too.
    commit(
      'other',
      canvasStateKey('misfiled'),
      version('elsewhere', 1, '2026-10-27T09:00:00.000Z')
    );
    expect(() => canvases.read({ canvasId: 'misfiled', threadId: 'other' })).toThrow(
      'another canvas key'
    );
  });
});
