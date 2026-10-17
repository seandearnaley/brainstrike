import { type HostLogRow, HostLogRowSchema } from '@brainstrike/agent-host/protocol';
import { canvasStateKey } from '@brainstrike/host-capabilities/canvas-state';
import richRecording from '@brainstrike/test-utils/fixtures/committed-rich-host-runs.json';
import { Schema } from 'effect';
import { expect, test, vi } from 'vitest';
import { createWindowThreadCapability } from '../renderer/desktop-host-thread-capability';
import { HostThreadCanvases } from '../renderer/host-thread-canvases';
import type { CommittedHostRunSource } from '../renderer/host-thread-runs';

vi.mock('../renderer/agent-host-client', () => ({ connectDesktopAgentHost: vi.fn() }));
const rich = richRecording.map((row) =>
  Schema.decodeUnknownSync(HostLogRowSchema, { errors: 'all', onExcessProperty: 'error' })(row)
);
const threadId = rich[0]?.threadId ?? '';
const runId = rich.flatMap((row) => (row.event.type === 'run.started' ? [row.event.runId] : []))[0];
if (!runId) {
  throw new Error('The recording has no run');
}
/** A canvas version as the host canvas store commits it: one tool state key per canvas. */
function canvasRow(seq: number, version: number): HostLogRow {
  return Schema.decodeUnknownSync(HostLogRowSchema, { errors: 'all', onExcessProperty: 'error' })({
    event: {
      key: canvasStateKey('canvas-1'),
      runId,
      toolCallId: `call-${version}`,
      type: 'tool.state.updated',
      value: {
        canvasId: 'canvas-1',
        createdAt: '2026-10-08T12:00:00.000Z',
        createdBy: 'assistant',
        html: `<p>v${version}</p>`,
        title: 'Chart',
        version,
      },
    },
    seq,
    threadId,
  });
}
/** The session's published view, driven explicitly. */
class Source implements CommittedHostRunSource {
  private snapshot: ReturnType<CommittedHostRunSource['getSnapshot']> = {
    isLoading: true,
    replayedThrough: undefined,
    rows: [],
  };
  private readonly listeners = new Set<() => void>();
  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  publish(rows: readonly HostLogRow[]): void {
    this.snapshot = { isLoading: false, replayedThrough: rows.at(-1)?.seq, rows };
    for (const listener of this.listeners) {
      listener();
    }
  }
}
test("a mounted view's committed canvas versions signal that thread's subscribers only", () => {
  const canvases = new HostThreadCanvases();
  const source = new Source();
  const listener = vi.fn();
  const otherThread = vi.fn();
  const unsubscribe = canvases.subscribe(threadId, listener);
  canvases.subscribe('another-thread', otherThread);
  const release = canvases.observe(threadId, source);
  // Replayed and live rows without a canvas version say nothing.
  source.publish(rich.slice(0, 10));
  source.publish(rich);
  expect(listener).not.toHaveBeenCalled();
  const next = (rich.at(-1)?.seq ?? 0) + 1;
  source.publish([...rich, canvasRow(next, 1)]);
  expect(listener).toHaveBeenCalledTimes(1);
  source.publish([...rich, canvasRow(next, 1), canvasRow(next + 1, 2)]);
  expect(listener).toHaveBeenCalledTimes(2);
  expect(otherThread).not.toHaveBeenCalled();
  // A released view, or an unsubscribed reader, hears nothing more.
  release();
  source.publish([...rich, canvasRow(next, 1), canvasRow(next + 1, 2), canvasRow(next + 2, 3)]);
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe();
  const again = new Source();
  canvases.observe(threadId, again);
  again.publish([canvasRow(1, 1)]);
  expect(listener).toHaveBeenCalledTimes(2);
});
test('a view whose replay already holds a canvas version signals once it loads', () => {
  const canvases = new HostThreadCanvases();
  const source = new Source();
  const listener = vi.fn();
  canvases.subscribe(threadId, listener);
  canvases.observe(threadId, source);
  expect(listener).not.toHaveBeenCalled();
  source.publish([...rich, canvasRow((rich.at(-1)?.seq ?? 0) + 1, 1)]);
  expect(listener).toHaveBeenCalledTimes(1);
});
test("the window capability's canvas subscribers hear its rendered views", () => {
  const views: HostThreadCanvases[] = [];
  const capability = createWindowThreadCapability(({ canvases }) => {
    views.push(canvases);
    return;
  });
  capability.renderThread(threadId, true);
  const [canvases] = views;
  if (!(canvases && capability.subscribeCanvases)) {
    throw new Error('The desktop capability offers live canvases to its views');
  }
  const listener = vi.fn();
  capability.subscribeCanvases(threadId, listener);
  const source = new Source();
  canvases.observe(threadId, source);
  source.publish([...rich, canvasRow((rich.at(-1)?.seq ?? 0) + 1, 1)]);
  expect(listener).toHaveBeenCalledTimes(1);
});
