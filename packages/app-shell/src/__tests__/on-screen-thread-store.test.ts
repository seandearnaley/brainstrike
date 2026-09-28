import { describe, expect, it } from 'vitest';
import { useOnScreenThreadStore } from '../stores/on-screen-thread-store';

describe('on-screen thread store', () => {
  it('starts with nothing on screen and follows what the transcript surface publishes', () => {
    expect(useOnScreenThreadStore.getState().onScreenThreadId).toBeNull();

    useOnScreenThreadStore.getState().setOnScreenThreadId('thread-a');
    expect(useOnScreenThreadStore.getState().onScreenThreadId).toBe('thread-a');

    useOnScreenThreadStore.getState().setOnScreenThreadId(null);
    expect(useOnScreenThreadStore.getState().onScreenThreadId).toBeNull();
  });

  it('is session-only: nothing about it is persisted', () => {
    expect(Reflect.has(useOnScreenThreadStore, 'persist')).toBe(false);
  });
});
