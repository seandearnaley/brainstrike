// @vitest-environment jsdom
/**
 * A host thread drives the Changes surface's "Last Turn" from its committed
 * log (BST-1977): its newest committed run is the identity "Last Turn"
 * follows, and each committed change to a run's workspace asks a "Last Turn"
 * view to re-resolve. The shared follower (app-shell) owns active-thread
 * gating and the throttle; this suite pins what the host thread feeds it.
 */
import { type HostLogRow, HostLogRowSchema } from '@brainstrike/agent-host';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { useHostLastTurn } from '../../renderer/use-host-last-turn';

const follower = vi.hoisted(() => ({
  activations: [] as (string | null)[],
  publishRun: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('@brainstrike/app-shell/changes/use-last-turn-follower', () => ({
  useLastTurnFollower: (_threadId: string | undefined, activationRunId: string | null) => {
    follower.activations.push(activationRunId);
    return { publishRun: follower.publishRun, refresh: follower.refresh };
  },
}));

const THREAD = 'host-thread-1';

beforeEach(() => {
  follower.activations.length = 0;
  follower.publishRun.mockClear();
  follower.refresh.mockClear();
});

let seq = 0;
function row(event: Record<string, unknown>): HostLogRow {
  seq += 1;
  return HostLogRowSchema.parse({ event, seq, threadId: THREAD });
}
const started = (runId: string) =>
  row({ modelId: 'scripted', prompt: 'Edit the file', runId, type: 'run.started' });
const chunk = (runId: string) =>
  row({ chunk: { delta: 'hello', type: 'text-delta' }, runId, type: 'stream.chunk' });
const toolFinished = (runId: string) =>
  row({ output: { path: 'a.txt' }, runId, toolCallId: 'call-1', type: 'effect.finished' });
const turnEnd = (runId: string) =>
  row({ boundary: 'turn-end', roots: [], runId, type: 'workspace.snapshot.recorded' });
const finished = (runId: string) => row({ outcome: 'completed', runId, type: 'run.finished' });

/** The committed session's observable surface, holding `rows`. */
function committed(initial: readonly HostLogRow[]) {
  let snapshot = { rows: initial };
  const listeners = new Set<() => void>();
  return {
    append: (...rows: HostLogRow[]) => {
      snapshot = { rows: [...snapshot.rows, ...rows] };
      for (const listener of listeners) {
        listener();
      }
    },
    source: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
}

test("follows the thread's newest committed run, from its history and as runs start", () => {
  const log = committed([started('run-1'), toolFinished('run-1'), finished('run-1')]);
  renderHook(() => useHostLastTurn(THREAD, log.source));
  // A host thread knows its past runs: activation publishes the newest.
  expect(follower.activations.at(-1)).toBe('run-1');
  expect(follower.publishRun).toHaveBeenLastCalledWith('run-1');

  act(() => log.append(started('run-2')));
  expect(follower.activations.at(-1)).toBe('run-2');
  expect(follower.publishRun).toHaveBeenLastCalledWith('run-2');
});

test('asks a Last Turn view to re-resolve on each committed workspace change, never on other rows', () => {
  const log = committed([started('run-1')]);
  renderHook(() => useHostLastTurn(THREAD, log.source));
  expect(follower.refresh).not.toHaveBeenCalled();

  act(() => log.append(chunk('run-1')));
  expect(follower.refresh).not.toHaveBeenCalled();

  act(() => log.append(toolFinished('run-1')));
  expect(follower.refresh).toHaveBeenCalledTimes(1);

  // The turn's end and the run's end commit in one append: one re-resolve.
  act(() => log.append(turnEnd('run-1'), finished('run-1')));
  expect(follower.refresh).toHaveBeenCalledTimes(2);
});

test('a host thread view before its committed session exists follows nothing', () => {
  renderHook(() => useHostLastTurn(THREAD, undefined));
  expect(follower.activations.at(-1)).toBeNull();
  expect(follower.publishRun).not.toHaveBeenCalled();
  expect(follower.refresh).not.toHaveBeenCalled();
});

test('a thread with no committed run publishes none', () => {
  const log = committed([]);
  renderHook(() => useHostLastTurn(THREAD, log.source));
  expect(follower.activations.at(-1)).toBeNull();
  expect(follower.publishRun).not.toHaveBeenCalled();
});
