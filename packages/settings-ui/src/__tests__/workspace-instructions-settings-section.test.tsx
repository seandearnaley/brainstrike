import { useWorkspaceInstructionsPreferencesStore } from '@brainstrike/app-state/stores/workspace-instructions-preferences-store';
import {
  BoundaryFailureError,
  type WorkspaceContextFileStatus,
} from '@brainstrike/assistant-contract';
import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { WorkspaceInstructionsSettingsSection } = await import(
  '../settings/system/workspace-instructions-settings-section'
);

let scanContextFiles: (() => Promise<WorkspaceContextFileStatus[]>) | undefined;

function stubHost(statuses: WorkspaceContextFileStatus[]) {
  scanContextFiles = vi.fn(async () => statuses);
}

/** The section as the desktop composes it, over the host's scan. */
function Section() {
  return (
    <WorkspaceInstructionsSettingsSection {...(scanContextFiles ? { scanContextFiles } : {})} />
  );
}

describe('WorkspaceInstructionsSettingsSection', () => {
  afterEach(() => {
    scanContextFiles = undefined;
  });

  it('renders the master toggle ON by default', async () => {
    stubHost([]);
    render(<Section />);
    expect(screen.getByTestId('context-files-master-toggle').getAttribute('aria-checked')).toBe(
      'true'
    );
    await screen.findByTestId('context-files-no-roots');
  });

  it('lists a fits file as Injected with size + token estimate', async () => {
    stubHost([
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
    render(<Section />);

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
    stubHost([
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
    render(<Section />);

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
    stubHost([
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
    render(<Section />);

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
      .fn<() => Promise<WorkspaceContextFileStatus[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
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
      ]);
    scanContextFiles = scan;
    render(<Section />);

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
    stubHost([]);
    render(<Section />);
    await waitFor(() => {
      expect(screen.getByTestId('context-files-no-roots')).not.toBeNull();
    });
  });

  it('shows a distinct error state (not the empty state) when the scan rejects', async () => {
    // A failed host scan arrives as the host's fixed internal fault, never its cause.
    scanContextFiles = vi.fn(async () => Promise.reject(new BoundaryFailureError(INTERNAL_FAULT)));
    render(<Section />);

    await waitFor(() => {
      expect(screen.getByTestId('context-files-scan-error')).not.toBeNull();
    });
    const errorBanner = screen.getByTestId('context-files-scan-error');
    expect(errorBanner.textContent).toContain(INTERNAL_FAULT.message);
    // The failure must NOT masquerade as "no folders open".
    expect(screen.queryByTestId('context-files-no-roots')).toBeNull();
  });

  it('retries the scan and clears the error on success', async () => {
    const scan = vi
      .fn<() => Promise<WorkspaceContextFileStatus[]>>()
      .mockRejectedValueOnce(new BoundaryFailureError(INTERNAL_FAULT))
      .mockResolvedValueOnce([]);
    scanContextFiles = scan;
    render(<Section />);

    await waitFor(() => {
      expect(screen.getByTestId('context-files-scan-error')).not.toBeNull();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(screen.queryByTestId('context-files-scan-error')).toBeNull();
    });
    expect(screen.getByTestId('context-files-no-roots')).not.toBeNull();
    expect(scan).toHaveBeenCalledTimes(2);
  });
});
