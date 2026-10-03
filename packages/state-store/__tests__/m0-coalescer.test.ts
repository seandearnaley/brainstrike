// M0-A1 guards of the shared write path (spike test/m0-coalescer.test.ts): commit-before-display stays, and each step
// boundary issues exactly one store sync AFTER its batch committed and was delivered, without the display path waiting
// on it.
import { describe, expect, test } from 'vitest';
import { Coalescer, type CoalescerLog, type RunChunk } from '../src/coalescer.js';
import type { AppendItem, LogRow } from '../src/run-log-types.js';
import { sleep } from './helpers/fs.js';

class FakeLog implements CoalescerLog {
  readonly trace: string[] = [];
  private readonly syncMs: number;
  private readonly syncError: Error | null;

  constructor(syncMs = 0, syncError: Error | null = null) {
    this.syncMs = syncMs;
    this.syncError = syncError;
  }

  append(items: readonly AppendItem[], onCommitted?: () => void): Promise<readonly LogRow[]> {
    for (const it of items) {
      if (it.event.type === 'ui.chunk') {
        for (const c of it.event['chunks'] as RunChunk[]) {
          this.trace.push(`commit:${it.threadId}:${c.type}`);
        }
      }
    }
    onCommitted?.();
    return Promise.resolve(
      items.map((it, i) => ({
        event: it.event,
        raw: JSON.stringify(it.event),
        seq: i + 1,
        threadId: it.threadId,
      }))
    );
  }

  syncBoundary(threadId: string): Promise<void> {
    this.trace.push(`sync:${threadId}`);
    return new Promise((res, rej) => {
      setTimeout(() => (this.syncError ? rej(this.syncError) : res()), this.syncMs);
    });
  }
}

const delta = (d: string): RunChunk => ({ delta: d, id: 't', type: 'text-delta' });
const finishStep: RunChunk = { type: 'finish-step' };

describe('M0-A1 Coalescer: step-boundary syncs', () => {
  test('C-order: a boundary sync is issued only after the batch holding its finish-step committed and was delivered', async () => {
    const log = new FakeLog();
    const co = new Coalescer(log, 20, (t, _r, c) => log.trace.push(`deliver:${t}:${c.type}`));
    for (const c of [delta('a'), finishStep]) {
      co.push('A', 'r', c);
      co.show('A', 'r', c);
    }
    await co.flush();
    await co.drainSyncs();
    expect(log.trace).toEqual([
      'commit:A:text-delta',
      'commit:A:finish-step',
      'deliver:A:text-delta',
      'deliver:A:finish-step',
      'sync:A',
    ]);
  });

  test('C-count: exactly one sync per finish-step, for the thread that took the step', async () => {
    const log = new FakeLog();
    const issued: string[] = [];
    const co = new Coalescer(log, 5, undefined, { onBoundarySyncIssued: (t) => issued.push(t) });
    const plan: [string, RunChunk][] = [
      ['A', delta('x')],
      ['A', finishStep],
      ['B', finishStep],
      ['A', delta('y')],
      ['A', finishStep],
      ['B', delta('z')],
    ];
    for (const [t, c] of plan) {
      co.push(t, 'r', c);
      co.show(t, 'r', c);
      await sleep(8);
    }
    await co.flush();
    await co.drainSyncs();
    expect(log.trace.filter((x) => x.startsWith('sync:')).sort()).toEqual([
      'sync:A',
      'sync:A',
      'sync:B',
    ]);
    expect(issued.sort()).toEqual(['A', 'A', 'B']);
  });

  test('C-nowait: neither the flush that carries a boundary nor later deliveries wait for its (400 ms) sync', async () => {
    const log = new FakeLog(400);
    const display: number[] = [];
    const settled: number[] = [];
    const co = new Coalescer(log, 20, undefined, {
      onBoundarySyncSettled: (_t, ms) => settled.push(ms),
      onDisplay: (ms) => display.push(ms),
    });
    for (const c of [delta('a'), finishStep]) {
      co.push('A', 'r', c);
      co.show('A', 'r', c);
    }
    const t0 = performance.now();
    await co.flush(); // the host awaits flush() before every step and boundary event (appendNow)
    expect(performance.now() - t0).toBeLessThan(100);
    for (let i = 0; i < 20; i++) {
      co.push('A', 'r', delta(String(i)));
      co.show('A', 'r', delta(String(i)));
      await sleep(5);
    }
    await co.flush();
    expect(display.length).toBe(22);
    expect(Math.max(...display)).toBeLessThan(150);
    expect(settled).toEqual([]); // still in flight while all of the above was delivered
    await co.drainSyncs();
    expect(settled.length).toBe(1);
    expect(settled[0]).toBeGreaterThanOrEqual(395);
  });

  test('C-fail: a failed sync is recorded and surfaces (drainSyncs rejects); it is never swallowed', async () => {
    const log = new FakeLog(5, new Error('EIO: simulated fsync failure'));
    const co = new Coalescer(log, 20);
    co.push('A', 'r', finishStep);
    co.show('A', 'r', finishStep);
    await co.flush();
    await expect(co.drainSyncs()).rejects.toThrow(/EIO/);
    expect(co.syncFailures.length).toBe(1);
  });
});
