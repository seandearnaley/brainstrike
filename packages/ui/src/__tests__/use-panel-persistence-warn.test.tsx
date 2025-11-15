import { renderHook } from '@testing-library/react';

// Mock dev environment BEFORE importing hook
vi.mock('@brainstrike/utils', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/utils')>('@brainstrike/utils');
  return {
    ...actual,
    isDevEnv: vi.fn(() => true),
  };
});

import { usePanelPersistence } from '../hooks/use-panel-persistence';

describe('usePanelPersistence Phase 2 strictness', () => {
  it('throws in dev when called without an explicit adapter', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      renderHook(() => usePanelPersistence([25, 55, 20], false, true, false, null))
    ).toThrow(/Missing explicit persistence adapter/);

    errorSpy.mockRestore();
  });
});
