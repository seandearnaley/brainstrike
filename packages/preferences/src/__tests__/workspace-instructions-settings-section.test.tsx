import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetWorkspaceInstructionsPreferencesStoreForTests,
  useWorkspaceInstructionsPreferencesStore,
} from '../stores/workspace-instructions-preferences-store';

const { WorkspaceInstructionsSettingsSection } = await import(
  '../settings/system/workspace-instructions-settings-section'
);

interface WorkspaceContextFileStatus {
  approxTokens: number | null;
  displayName: string;
  error?: string;
  fileName: string | null;
  oversized: boolean;
  path: string | null;
  rootId: string;
  sizeBytes: number | null;
  status: 'none' | 'fits' | 'oversized' | 'error';
}

function stubBridge(statuses: WorkspaceContextFileStatus[]) {
  Object.defineProperty(window, 'contextFiles', {
    configurable: true,
    value: { scan: vi.fn(async () => statuses) },
  });
}

function stubRejectingBridge(error: Error) {
  Object.defineProperty(window, 'contextFiles', {
    configurable: true,
    value: { scan: vi.fn(async () => Promise.reject(error)) },
  });
}

describe('WorkspaceInstructionsSettingsSection', () => {
  beforeEach(() => {
    __resetWorkspaceInstructionsPreferencesStoreForTests();
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'contextFiles');
    __resetWorkspaceInstructionsPreferencesStoreForTests();
  });

  it('renders the master toggle ON by default', () => {
    stubBridge([]);
    render(<WorkspaceInstructionsSettingsSection />);
    expect(screen.getByTestId('context-files-master-toggle').getAttribute('aria-checked')).toBe(
      'true'
    );
  });

  it('lists a fits file as Injected with size + token estimate', async () => {
    stubBridge([
      {
        approxTokens: 300,
        displayName: 'repo-a',
        fileName: 'AGENTS.md',
        oversized: false,
        path: 'AGENTS.md',
        rootId: 'root-a',
        sizeBytes: 1200,
        status: 'fits',
      },
    ]);
    render(<WorkspaceInstructionsSettingsSection />);

    await waitFor(() => {
      expect(screen.getByTestId('context-files-root-root-a')).not.toBeNull();
    });
    const row = screen.getByTestId('context-files-root-root-a');
    expect(row.textContent).toContain('AGENTS.md');
    expect(row.textContent).toContain('1.2 KB');
    expect(row.textContent).toContain('~300 tokens');
    expect(row.textContent).toContain('Injected');
    // No opt-in toggle for a fits file.
    expect(screen.queryByTestId('context-files-optin-root-a')).toBeNull();
  });

  it('shows an oversized file as detected-but-not-injected with an opt-in toggle', async () => {
    stubBridge([
      {
        approxTokens: 8000,
        displayName: 'repo-big',
        fileName: 'AGENTS.md',
        oversized: true,
        path: 'AGENTS.md',
        rootId: 'root-big',
        sizeBytes: 30_720,
        status: 'oversized',
      },
    ]);
    render(<WorkspaceInstructionsSettingsSection />);

    await waitFor(() => {
      expect(screen.getByTestId('context-files-root-root-big')).not.toBeNull();
    });
    const row = screen.getByTestId('context-files-root-root-big');
    expect(row.textContent).toContain('Too large');
    expect(row.textContent).toContain('Detected but not injected');
    expect(row.textContent).toContain('30.0 KB');

    const optIn = screen.getByTestId('context-files-optin-root-big');
    expect(optIn.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(optIn);
    expect(useWorkspaceInstructionsPreferencesStore.getState().oversizedOptInByRootId).toEqual({
      'root-big': true,
    });
  });

  it('shows an empty state when no roots have a context file', async () => {
    stubBridge([]);
    render(<WorkspaceInstructionsSettingsSection />);
    await waitFor(() => {
      expect(screen.getByTestId('context-files-no-roots')).not.toBeNull();
    });
  });

  it('shows a distinct error state (not the empty state) when the scan rejects', async () => {
    stubRejectingBridge(new Error('database unavailable'));
    render(<WorkspaceInstructionsSettingsSection />);

    await waitFor(() => {
      expect(screen.getByTestId('context-files-scan-error')).not.toBeNull();
    });
    const errorBanner = screen.getByTestId('context-files-scan-error');
    expect(errorBanner.textContent).toContain('database unavailable');
    // The failure must NOT masquerade as "no folders open".
    expect(screen.queryByTestId('context-files-no-roots')).toBeNull();
  });

  it('retries the scan and clears the error on success', async () => {
    const scan = vi
      .fn<() => Promise<WorkspaceContextFileStatus[]>>()
      .mockRejectedValueOnce(new Error('transient failure'))
      .mockResolvedValueOnce([]);
    Object.defineProperty(window, 'contextFiles', {
      configurable: true,
      value: { scan },
    });
    render(<WorkspaceInstructionsSettingsSection />);

    await waitFor(() => {
      expect(screen.getByTestId('context-files-scan-error')).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId('context-files-scan-retry'));

    await waitFor(() => {
      expect(screen.queryByTestId('context-files-scan-error')).toBeNull();
    });
    expect(screen.getByTestId('context-files-no-roots')).not.toBeNull();
    expect(scan).toHaveBeenCalledTimes(2);
  });
});
