// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('@brainstrike/hooks', async () => {
  const { useEventCallbackMock } = await import('./__mocks__/use-event-callback-mock');
  return { useEventCallback: useEventCallbackMock };
});

const { useEventCallback } = await import('@brainstrike/hooks');

describe('useEventCallbackMock', () => {
  it('loads through a hoisted mock factory and preserves the callback contract', () => {
    const callback = vi.fn((value: number) => `value:${value}`);

    const mockedCallback = useEventCallback(callback);

    expect(mockedCallback).toBe(callback);
    expect(mockedCallback(42)).toBe('value:42');
    expect(callback).toHaveBeenCalledWith(42);
  });
});
