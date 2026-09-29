import { describe, expect, it, vi } from 'vitest';
import { useOnScreenThreadStore } from '../stores/on-screen-thread-store';

describe('on-screen thread store', () => {
  it('starts with nothing on screen and follows what the transcript surface publishes', () => {
    expect(useOnScreenThreadStore.getState().onScreenThreadId).toBeNull();

    useOnScreenThreadStore.getState().setOnScreenThreadId('thread-a');
    expect(useOnScreenThreadStore.getState().onScreenThreadId).toBe('thread-a');

    useOnScreenThreadStore.getState().setOnScreenThreadId(null);
    expect(useOnScreenThreadStore.getState().onScreenThreadId).toBeNull();
  });

  it('releases a claim only while it is still the published one', () => {
    const { releaseOnScreenThreadId, setOnScreenThreadId } = useOnScreenThreadStore.getState();
    setOnScreenThreadId('thread-b');
    const writes = vi.fn();
    const unsubscribe = useOnScreenThreadStore.subscribe(writes);

    releaseOnScreenThreadId('thread-a');
    expect(useOnScreenThreadStore.getState().onScreenThreadId).toBe('thread-b');
    expect(writes).not.toHaveBeenCalled();

    releaseOnScreenThreadId('thread-b');
    expect(useOnScreenThreadStore.getState().onScreenThreadId).toBeNull();
    expect(writes).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('is session-only: nothing about it is persisted', () => {
    expect(Reflect.has(useOnScreenThreadStore, 'persist')).toBe(false);
  });
});
