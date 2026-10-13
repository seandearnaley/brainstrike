import { describe, expect, it, vi } from 'vitest';
import { type ChildGenerationContext, createChildSupervisor } from '../child-supervisor';

function fixture(restart: 'lazy' | 'immediate' | 'never' = 'lazy') {
  const generations: {
    context: ChildGenerationContext;
    ready: ReturnType<typeof Promise.withResolvers<{ pid: number }>>;
    close: ReturnType<typeof vi.fn<() => Promise<void>>>;
  }[] = [];
  const create = vi.fn((context: ChildGenerationContext) => {
    const ready = Promise.withResolvers<{ pid: number }>();
    const close = vi.fn(async () => {});
    generations.push({ close, context, ready });
    return { close, ready: ready.promise };
  });
  return { create, generations, supervisor: createChildSupervisor({ create, restart }) };
}

async function opened(f: ReturnType<typeof fixture>) {
  const supervisor = await f.supervisor;
  const starting = supervisor.acquire();
  await vi.waitFor(() => expect(f.generations).toHaveLength(1));
  f.generations[0]!.ready.resolve({ pid: 101 });
  await starting;
  return supervisor;
}

describe('ChildSupervisor owns the replacement policy', () => {
  it('shares readiness, permits one lazy replacement, and rearms only on explicit restart', async () => {
    const f = fixture();
    const supervisor = await opened(f);
    const loss = new Error('recorded utility exit 1');
    await f.generations[0]!.context.lost(loss);
    expect(f.create).toHaveBeenCalledTimes(1);
    const first = supervisor.acquire();
    const second = supervisor.acquire();
    await vi.waitFor(() => expect(f.generations).toHaveLength(2));
    expect(f.generations[0]!.close).toHaveBeenCalledTimes(1);
    f.generations[1]!.ready.resolve({ pid: 102 });
    expect(await first).toBe(await second);
    const secondLoss = new Error('recorded replacement exit 1');
    await f.generations[1]!.context.lost(secondLoss);
    await expect(supervisor.acquire()).rejects.toBe(secondLoss);
    expect(f.create).toHaveBeenCalledTimes(2);
    const retry = supervisor.restart();
    await vi.waitFor(() => expect(f.generations).toHaveLength(3));
    f.generations[2]!.ready.resolve({ pid: 103 });
    await retry;
    await f.generations[2]!.context.lost(loss);
    expect((await supervisor.snapshot()).kind).toBe('lost');
    await supervisor.stop();
  });

  it('ignores stale loss and joins actual cleanup before automatic replacement', async () => {
    const f = fixture('immediate');
    const supervisor = await opened(f);
    const physical = Promise.withResolvers<void>();
    f.generations[0]!.close.mockReturnValue(physical.promise);
    const loss = f.generations[0]!.context.lost(new Error('render-process-gone crashed 11'));
    await vi.waitFor(async () => expect((await supervisor.snapshot()).kind).toBe('restarting'));
    expect(f.create).toHaveBeenCalledTimes(1);
    physical.resolve();
    await vi.waitFor(() => expect(f.generations).toHaveLength(2));
    f.generations[1]!.ready.resolve({ pid: 102 });
    await loss;
    await f.generations[0]!.context.lost(new Error('late closed'));
    expect((await supervisor.snapshot()).kind).toBe('ready');
    await supervisor.stop();
  });

  it('stop supersedes readiness and does not count its exit as a loss', async () => {
    const f = fixture('immediate');
    const supervisor = await f.supervisor;
    const reason = new Error('shutdown');
    const starting = supervisor.acquire();
    const rejected = expect(starting).rejects.toBe(reason);
    await vi.waitFor(() => expect(f.generations).toHaveLength(1));
    await supervisor.stop(reason);
    await f.generations[0]!.context.lost(new Error('exit 0'));
    f.generations[0]!.ready.resolve({ pid: 101 });
    await rejected;
    expect((await supervisor.snapshot()).kind).toBe('stopped');
    expect(f.create).toHaveBeenCalledTimes(1);
    await expect(supervisor.acquire()).rejects.toBe(reason);
  });

  it('retains failed cleanup and refuses replacement until an explicit cleanup retry succeeds', async () => {
    const f = fixture();
    const supervisor = await opened(f);
    const failure = new Error('Root still held');
    f.generations[0]!.close.mockRejectedValueOnce(failure);
    await expect(supervisor.stop()).rejects.toBe(failure);
    await expect(supervisor.acquire()).rejects.toBe(failure);
    expect(f.create).toHaveBeenCalledTimes(1);
    await supervisor.stop();
    expect(f.generations[0]!.close).toHaveBeenCalledTimes(2);
    expect((await supervisor.snapshot()).kind).toBe('stopped');
  });

  it('does not restart a database child on later requests', async () => {
    const f = fixture('never');
    const supervisor = await opened(f);
    const cause = new Error('db utility exit 1');
    await f.generations[0]!.context.lost(cause);
    await expect(supervisor.acquire()).rejects.toBe(cause);
    expect(f.create).toHaveBeenCalledTimes(1);
    await supervisor.stop();
  });
});

describe('ChildSupervisor startup ownership', () => {
  it('keeps a loss during readiness retryable after the original ready promise rejects', async () => {
    const f = fixture();
    const supervisor = await f.supervisor;
    const starting = supervisor.acquire();
    const cause = new Error('utility exited before ready');
    const failure = expect(starting).rejects.toBe(cause);
    await vi.waitFor(() => expect(f.generations).toHaveLength(1));
    await f.generations[0]!.context.lost(cause);
    f.generations[0]!.ready.reject(cause);
    await failure;
    expect((await supervisor.snapshot()).kind).toBe('lost');
    expect(await supervisor.retireLost()).toBe(true);
    expect(await supervisor.retireLost()).toBe(false);
    await supervisor.stop();
  });

  it('surfaces a refused construction without replacing it on passive demand', async () => {
    const cause = new Error('foreign live Root lease');
    const create = vi.fn(() => {
      throw cause;
    });
    const supervisor = await createChildSupervisor({ create, restart: 'lazy' });
    await expect(supervisor.acquire()).rejects.toBe(cause);
    await expect(supervisor.acquire()).rejects.toBe(cause);
    expect(create).toHaveBeenCalledOnce();
    await supervisor.stop();
  });

  it('coalesces simultaneous explicit retries while old physical cleanup is held', async () => {
    const f = fixture();
    const supervisor = await opened(f);
    const physical = Promise.withResolvers<void>();
    f.generations[0]!.close.mockReturnValue(physical.promise);
    const first = supervisor.restart();
    const second = supervisor.restart();
    expect(f.create).toHaveBeenCalledTimes(1);
    physical.resolve();
    await vi.waitFor(() => expect(f.generations).toHaveLength(2));
    f.generations[1]!.ready.resolve({ pid: 102 });
    expect(await first).toBe(await second);
    expect(f.create).toHaveBeenCalledTimes(2);
    await supervisor.stop();
  });
});
