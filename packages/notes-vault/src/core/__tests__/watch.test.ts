import { describe, expect, it, vi } from 'vitest';
import { fakeDir } from '../../__tests__/support/fake-handles';
import { createVaultWatcher, type VaultObserverConstructor } from '../watch';

interface ObservedCall {
  handle: unknown;
  options: unknown;
}

function fakeObserverWorld(): {
  ctor: VaultObserverConstructor;
  observed: ObservedCall[];
  disconnects: number[];
  emit: (() => void)[];
} {
  const observed: ObservedCall[] = [];
  const disconnects: number[] = [];
  const emit: (() => void)[] = [];
  class FakeObserver {
    readonly #callback: () => void;
    constructor(callback: () => void) {
      this.#callback = callback;
      emit.push(() => this.#callback());
    }
    observe(handle: unknown, options: unknown): Promise<void> {
      observed.push({ handle, options });
      return FakeObserver.observeResult;
    }
    static observeResult: Promise<void> = Promise.resolve();
    disconnect(): void {
      disconnects.push(1);
    }
  }
  return { ctor: FakeObserver as unknown as VaultObserverConstructor, disconnects, emit, observed };
}

describe('createVaultWatcher', () => {
  it('returns null when the FileSystemObserver capability is absent', () => {
    expect(createVaultWatcher(fakeDir('vault'), vi.fn(), undefined)).toBeNull();
  });

  it('observes the root recursively and forwards change batches', async () => {
    const world = fakeObserverWorld();
    const onChange = vi.fn();
    const dir = fakeDir('vault');

    const watcher = createVaultWatcher(dir, onChange, world.ctor, vi.fn());
    expect(watcher).not.toBeNull();
    await Promise.resolve();

    expect(world.observed).toEqual([{ handle: dir, options: { recursive: true } }]);
    world.emit[0]?.();
    expect(onChange).toHaveBeenCalledTimes(1);

    watcher?.disconnect();
    expect(world.disconnects).toHaveLength(1);
  });
});

describe('observe failure surfacing', () => {
  it('reports observe() rejection through onError instead of pretending to watch', async () => {
    const world = fakeObserverWorld();
    const failure = new DOMException('revoked', 'NotAllowedError');
    (world.ctor as unknown as { observeResult: Promise<void> }).observeResult =
      Promise.reject(failure);
    const onError = vi.fn();

    const watcher = createVaultWatcher(fakeDir('vault'), vi.fn(), world.ctor, onError);
    expect(watcher).not.toBeNull();
    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(failure);
    });
  });
});
