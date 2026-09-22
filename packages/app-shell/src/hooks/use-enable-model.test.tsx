import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEnableModel } from './use-enable-model';

const { toastMock, toggleMock } = vi.hoisted(() => ({
  toastMock: vi.fn(),
  toggleMock: vi.fn(async () => true),
}));

vi.mock('@brainstrike/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...actual,
    useToast: () => ({ toast: toastMock }),
  };
});

vi.mock('@brainstrike/settings-ui/settings/models/use-model-toggle', () => ({
  useModelToggle: () => ({ busyModelIds: new Set<string>(), toggle: toggleMock }),
}));

afterEach(() => {
  toastMock.mockReset();
  toggleMock.mockReset().mockResolvedValue(true);
});

describe('useEnableModel', () => {
  it('toggles a hosted-runtime model through useModelToggle and resolves its result, without a toast', async () => {
    const { result } = renderHook(() => useEnableModel());

    await expect(result.current('anthropic', 'claude-opus-5')).resolves.toBe(true);
    expect(toggleMock).toHaveBeenCalledWith('claude-opus-5', true);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('refuses a local-runtime provider without calling toggle', async () => {
    const { result } = renderHook(() => useEnableModel());

    await expect(result.current('ollama', 'llama3')).resolves.toBe(false);
    expect(toggleMock).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'ollama models are enabled by their runtime, not the model registry.',
        title: 'Could not enable this model',
        variant: 'destructive',
      })
    );
  });

  it('refuses an unsupported provider id without calling toggle', async () => {
    const { result } = renderHook(() => useEnableModel());

    await expect(result.current('not-a-provider', 'some-model')).resolves.toBe(false);
    expect(toggleMock).not.toHaveBeenCalled();
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'not-a-provider models are enabled by their runtime, not the model registry.',
        title: 'Could not enable this model',
        variant: 'destructive',
      })
    );
  });

  it('returns a stable callback identity across renders', () => {
    const { rerender, result } = renderHook(() => useEnableModel());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
