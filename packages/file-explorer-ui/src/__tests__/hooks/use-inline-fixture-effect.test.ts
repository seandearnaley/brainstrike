import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useInlineFixtureEffect } from '../../hooks/use-inline-fixture-effect';

vi.mock('@brainstrike/utils', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/utils')>();
  return {
    ...original,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

describe('useInlineFixtureEffect', () => {
  const strings = {
    successTitle: 'Success',
    errorTitle: 'Error',
    enableSuccess: 'enabled',
    disableSuccess: 'disabled',
    enableError: 'enable failed',
    disableError: 'disable failed',
  } as const;

  it('does not repeatedly call loadInlineFixture on rerenders when enabled', async () => {
    const loadInlineFixture = vi.fn().mockResolvedValue({
      path: '',
      name: 'mock-project',
      kind: 'directory',
      platform: 'web',
    });
    const clearInlineFixture = vi.fn().mockResolvedValue(undefined);

    const setDevInlineFixtureEnabled = vi.fn();
    const setRootDirectoryHandle = vi.fn();

    const fileSystemAdapter = {
      canLoadInlineFixture: true,
      loadInlineFixture,
      clearInlineFixture,
      isInlineFixtureActive: () => false,
    };

    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useInlineFixtureEffect({
          fileSystemAdapter: fileSystemAdapter as any,
          devInlineFixtureEnabled: enabled,
          setDevInlineFixtureEnabled,
          setRootDirectoryHandle,
          clearRootDirectory: undefined,
          showToast: undefined,
          // Pass a fresh object each render to simulate FileExplorerLeftPanel behavior
          strings: { ...strings },
        }),
      { initialProps: { enabled: true } }
    );

    await waitFor(() => expect(loadInlineFixture).toHaveBeenCalledTimes(1));

    // Rerender multiple times with the same enabled state; should NOT trigger more enables.
    for (let i = 0; i < 5; i++) {
      rerender({ enabled: true });
    }

    expect(loadInlineFixture).toHaveBeenCalledTimes(1);
    expect(clearInlineFixture).not.toHaveBeenCalled();
  });

  it('disables by calling clearInlineFixture and clearing the root directory', async () => {
    let active = false;
    const loadInlineFixture = vi.fn().mockImplementation(async () => {
      active = true;
      return {
        path: '',
        name: 'mock-project',
        kind: 'directory',
        platform: 'web',
      };
    });
    const clearInlineFixture = vi.fn().mockImplementation(async () => {
      active = false;
    });
    const clearRootDirectory = vi.fn();

    const setDevInlineFixtureEnabled = vi.fn();
    const setRootDirectoryHandle = vi.fn();

    const fileSystemAdapter = {
      canLoadInlineFixture: true,
      loadInlineFixture,
      clearInlineFixture,
      isInlineFixtureActive: () => active,
    };

    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useInlineFixtureEffect({
          fileSystemAdapter: fileSystemAdapter as any,
          devInlineFixtureEnabled: enabled,
          setDevInlineFixtureEnabled,
          setRootDirectoryHandle,
          clearRootDirectory,
          showToast: undefined,
          strings: { ...strings },
        }),
      { initialProps: { enabled: true } }
    );

    await waitFor(() => expect(loadInlineFixture).toHaveBeenCalledTimes(1));

    // Now disable
    await act(async () => {
      rerender({ enabled: false });
    });

    await waitFor(() => expect(clearInlineFixture).toHaveBeenCalledTimes(1));
    expect(clearRootDirectory).toHaveBeenCalledTimes(1);
  });
});
