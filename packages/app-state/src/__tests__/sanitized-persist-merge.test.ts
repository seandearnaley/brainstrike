// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createSanitizedPersistMerge } from '../stores/sanitized-persist-merge';

describe('createSanitizedPersistMerge', () => {
  it('preserves the exact live state when storage has no persisted snapshot', () => {
    const currentState = {
      enabled: true,
      setEnabled: (_enabled: boolean) => undefined,
    };
    const sanitize = vi.fn(() => ({ enabled: false }));
    const merge = createSanitizedPersistMerge<typeof currentState, { enabled: boolean }>(sanitize);

    const merged = merge(undefined, currentState);

    expect(merged).toBe(currentState);
    expect(merged.enabled).toBe(true);
    expect(sanitize).not.toHaveBeenCalled();
  });

  it('keeps actions while admitting only the sanitizer complete data shape', () => {
    const setEnabled = (_enabled: boolean) => undefined;
    const currentState = { enabled: true, label: 'current', setEnabled };
    const merge = createSanitizedPersistMerge<
      typeof currentState,
      { enabled: boolean; label: string }
    >(() => ({ enabled: false, label: 'sanitized' }));

    const merged = merge({ enabled: 'yes', injectedAction: 'bad' }, currentState);

    expect(merged).toEqual({ enabled: false, label: 'sanitized', setEnabled });
    expect('injectedAction' in merged).toBe(false);
  });
});
