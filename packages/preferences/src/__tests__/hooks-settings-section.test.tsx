import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetHookTrustStoreForTests, useHookTrustStore } from '../stores/hook-trust-store';

const { HooksSettingsSection } = await import('../settings/system/hooks-settings-section');

interface ProjectHooksReview {
  content?: string;
  error?: string;
  exists: boolean;
  parseError?: string;
  path: string;
  rootId: string;
  sha256?: string;
}

const roots = [{ absPath: '/ws/a', displayName: 'Workspace A', rootId: 'root-a' }];

function mockBridge(review: ProjectHooksReview): void {
  (window as Window & { hooks?: unknown }).hooks = {
    getProjectHooksForReview: vi.fn(() => Promise.resolve(review)),
  };
}

beforeEach(() => {
  __resetHookTrustStoreForTests();
});

afterEach(() => {
  Reflect.deleteProperty(window as Window & { hooks?: unknown }, 'hooks');
});

describe('HooksSettingsSection', () => {
  it('shows an empty state when no roots are mounted', () => {
    render(<HooksSettingsSection roots={[]} />);
    expect(screen.getByTestId('hooks-no-roots')).not.toBeNull();
  });

  it('approves a root, pinning the current file hash', async () => {
    mockBridge({
      content: '{}',
      exists: true,
      path: '/ws/a/.brainstrike/hooks.json',
      rootId: 'root-a',
      sha256: 'hash-1',
    });
    render(<HooksSettingsSection roots={roots} />);

    const approve = await screen.findByTestId('hooks-approve-root-a');
    fireEvent.click(approve);

    await waitFor(() => {
      expect(useHookTrustStore.getState().approvalsByRootId['root-a']?.sha256).toBe('hash-1');
    });
    // After approval the status becomes trusted → a Revoke button appears.
    expect(await screen.findByTestId('hooks-revoke-root-a')).not.toBeNull();
  });

  it('revokes a trusted root', async () => {
    useHookTrustStore.getState().approveRoot('root-a', 'hash-1');
    mockBridge({
      content: '{}',
      exists: true,
      path: '/ws/a/.brainstrike/hooks.json',
      rootId: 'root-a',
      sha256: 'hash-1',
    });
    render(<HooksSettingsSection roots={roots} />);

    const revoke = await screen.findByTestId('hooks-revoke-root-a');
    fireEvent.click(revoke);

    await waitFor(() => {
      expect(useHookTrustStore.getState().approvalsByRootId['root-a']).toBeUndefined();
    });
  });

  it('shows "changed" when the approved hash no longer matches disk', async () => {
    useHookTrustStore.getState().approveRoot('root-a', 'old-hash');
    mockBridge({
      content: '{}',
      exists: true,
      path: '/ws/a/.brainstrike/hooks.json',
      rootId: 'root-a',
      sha256: 'new-hash',
    });
    render(<HooksSettingsSection roots={roots} />);

    expect(await screen.findByText(/Changed — re-approve/)).not.toBeNull();
    // A changed root offers Approve (to re-pin), not Revoke.
    expect(screen.getByTestId('hooks-approve-root-a')).not.toBeNull();
  });

  it('shows an error state when the review bridge rejects for a root', async () => {
    (window as Window & { hooks?: unknown }).hooks = {
      getProjectHooksForReview: vi.fn(() => Promise.reject(new Error('ipc down'))),
    };
    render(<HooksSettingsSection roots={roots} />);

    // A transport-level bridge failure must surface as a visible per-row error,
    // never a stale "Untrusted"/empty state (honest failure surfacing).
    expect(await screen.findByText(/Unavailable/)).not.toBeNull();
  });

  it('disables approve for a config with a parse error', async () => {
    mockBridge({
      content: '{ bad',
      exists: true,
      parseError: 'Unexpected token',
      path: '/ws/a/.brainstrike/hooks.json',
      rootId: 'root-a',
      sha256: 'hash-1',
    });
    render(<HooksSettingsSection roots={roots} />);

    const approve = await screen.findByTestId('hooks-approve-root-a');
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Config error/)).not.toBeNull();
  });
});
