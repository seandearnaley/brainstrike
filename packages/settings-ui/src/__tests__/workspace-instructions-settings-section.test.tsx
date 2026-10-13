import {
  __resetWorkspaceInstructionsPreferencesStoreForTests,
  useWorkspaceInstructionsPreferencesStore,
} from '@brainstrike/app-state/stores/workspace-instructions-preferences-store';
import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type { WorkspaceContextFileStatus } from '@brainstrike/assistant-contract/context-files-bridge';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { WorkspaceInstructionsSettingsSection } = await import(
  '../settings/system/workspace-instructions-settings-section'
);

function stubBridge(statuses: WorkspaceContextFileStatus[]) {
  Object.defineProperty(window, 'contextFiles', {
    configurable: true,
    value: { scan: vi.fn(async () => ({ ok: true, value: statuses })) },
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

  it('renders a present-but-unreadable file as an Unavailable row with the failure detail', async () => {
    // The last unpinned hop: a scan that returns a per-root status:'error' entry
    // must surface as the "Unavailable" badge + the destructive error detail in
    // the actual settings UI (not the whole-scan rejection banner).
    stubBridge([
      {
        approxTokens: null,
        displayName: 'repo-broken',
        error: 'exceeds the 2 MB read cap',
        fileName: null,
        oversized: false,
        path: null,
        rootId: 'root-broken',
        sizeBytes: null,
        status: 'error',
      },
    ]);
    render(<WorkspaceInstructionsSettingsSection />);

    await waitFor(() => {
      expect(screen.getByTestId('context-files-root-root-broken')).not.toBeNull();
    });
    const row = screen.getByTestId('context-files-root-root-broken');
    expect(row.textContent).toContain('Unavailable');
    expect(row.textContent).toContain('exceeds the 2 MB read cap');
    // An error row is NOT the whole-scan rejection banner, and offers no opt-in.
    expect(screen.queryByTestId('context-files-scan-error')).toBeNull();
    expect(screen.queryByTestId('context-files-optin-root-broken')).toBeNull();
  });

  it('rescans on demand so a mid-session root change can be refreshed', async () => {
    const scan = vi
      .fn<() => Promise<BoundaryResult<WorkspaceContextFileStatus[]>>>()
      .mockResolvedValueOnce({ ok: true, value: [] })
      .mockResolvedValueOnce({
        ok: true,
        value: [
          {
            approxTokens: 300,
            displayName: 'repo-late',
            fileName: 'AGENTS.md',
            oversized: false,
            path: 'AGENTS.md',
            rootId: 'root-late',
            sizeBytes: 1200,
            status: 'fits',
          },
        ],
      });
    Object.defineProperty(window, 'contextFiles', {
      configurable: true,
      value: { scan },
    });
    render(<WorkspaceInstructionsSettingsSection />);

    await waitFor(() => {
      expect(screen.getByTestId('context-files-no-roots')).not.toBeNull();
    });
    fireEvent.click(screen.getByTestId('context-files-rescan'));

    await waitFor(() => {
      expect(screen.getByTestId('context-files-root-root-late')).not.toBeNull();
    });
    expect(scan).toHaveBeenCalledTimes(2);
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
    expect(errorBanner.textContent).toContain(INTERNAL_FAULT.message);
    expect(errorBanner.textContent).not.toContain('database unavailable');
    // The failure must NOT masquerade as "no folders open".
    expect(screen.queryByTestId('context-files-no-roots')).toBeNull();
  });

  it('retries the scan and clears the error on success', async () => {
    const scan = vi
      .fn<() => Promise<BoundaryResult<WorkspaceContextFileStatus[]>>>()
      .mockRejectedValueOnce(new Error('transient failure'))
      .mockResolvedValueOnce({ ok: true, value: [] });
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
