import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { createNodeHostSpawner, HOST_STARTER_READY_TIMEOUT_MS } from '../src/node-spawner.js';

const recorded = vi.hoisted(() => ({ deadlines: [] as number[] }));

// A starter that is never observed reporting: the readiness wait is recorded
// and refused at once, so only the deadline it was given is under test.
vi.mock('@brainstrike/effect-kit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/effect-kit')>()),
  runWithTimeout: (_task: unknown, options: { readonly timeoutMs: number }) => {
    recorded.deadlines.push(options.timeoutMs);
    return Promise.reject(new Error('Recorded readiness deadline'));
  },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const { EventEmitter } = await import('node:events');
  class StarterChild extends EventEmitter {
    connected = true;
    exitCode: number | null = null;
    pid = 4242;
    signalCode: NodeJS.Signals | null = null;
    disconnect(): void {
      this.connected = false;
      this.emit('disconnect');
    }
    kill(signal: NodeJS.Signals): boolean {
      this.signalCode = signal;
      queueMicrotask(() => this.emit('exit', null, signal));
      return true;
    }
    unref(): void {}
  }
  return {
    ...(await importOriginal<typeof import('node:child_process')>()),
    fork: () => new StarterChild(),
    spawn: () => new StarterChild(),
  };
});

test('the host starter waits the production readiness deadline unless a caller narrows it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-lease-ready-deadline-'));
  try {
    const start = { lifetime: 'persistent', root } as const;
    await expect(createNodeHostSpawner()(start, new AbortController().signal)).rejects.toThrow(
      'Recorded readiness deadline'
    );
    await expect(
      createNodeHostSpawner({ readyTimeoutMs: 1234 })(start, new AbortController().signal)
    ).rejects.toThrow('Recorded readiness deadline');
    expect(HOST_STARTER_READY_TIMEOUT_MS).toBe(10_000);
    expect(recorded.deadlines).toEqual([10_000, 1234]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
