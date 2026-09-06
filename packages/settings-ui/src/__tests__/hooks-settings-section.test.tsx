import {
  __resetHookTrustStoreForTests,
  useHookTrustStore,
} from '@brainstrike/app-state/stores/hook-trust-store';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { HooksSettingsSection } = await import('../settings/system/hooks-settings-section');

interface ProjectHooksReview {
  content?: string;
  dbRootId?: string;
  error?: string;
  exists: boolean;
  parseError?: string;
  path: string;
  rootId: string;
  sha256?: string;
}

const roots = [{ absPath: '/ws/a', displayName: 'Workspace A', rootId: 'root-a' }];

/**
 * The production bridge is `ipcRenderer.invoke` — a real IPC round-trip that
 * can NEVER settle within the caller's microtask checkpoint. Resolving on a
 * macrotask delivers that runtime shape: a row is guaranteed to render its
 * in-flight "Checking…" state at least once before the review lands, which is
 * exactly the interleaving CI hits and a `Promise.resolve()` fixture hides.
 */
function mockBridge(review: ProjectHooksReview): void {
  (window as Window & { hooks?: unknown }).hooks = {
    getProjectHooksForReview: vi.fn(
      () =>
        new Promise<ProjectHooksReview>((resolve) => {
          setTimeout(() => resolve(review), 0);
        })
    ),
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

  it('approves a root, keying the grant by the DB root id and pinning the hash', async () => {
    mockBridge({
      content: '{}',
      dbRootId: 'db-a',
      exists: true,
      path: '/ws/a/.brainstrike/hooks.json',
      rootId: 'root-a',
      sha256: 'hash-1',
    });
    render(<HooksSettingsSection roots={roots} />);

    const approve = await screen.findByTestId('hooks-approve-root-a');
    fireEvent.click(approve);

    await waitFor(() => {
      // Keyed by the server's DB root id, not the ephemeral adapter id.
      expect(useHookTrustStore.getState().approvalsByRootId['db-a']?.sha256).toBe('hash-1');
    });
    expect(useHookTrustStore.getState().approvalsByRootId['root-a']).toBeUndefined();
    // After approval the status becomes trusted → a Revoke button appears.
    expect(await screen.findByTestId('hooks-revoke-root-a')).not.toBeNull();
  });

  it('revokes a trusted root by its DB root id', async () => {
    useHookTrustStore.getState().approveRoot('db-a', 'hash-1');
    mockBridge({
      content: '{}',
      dbRootId: 'db-a',
      exists: true,
      path: '/ws/a/.brainstrike/hooks.json',
      rootId: 'root-a',
      sha256: 'hash-1',
    });
    render(<HooksSettingsSection roots={roots} />);

    const revoke = await screen.findByTestId('hooks-revoke-root-a');
    fireEvent.click(revoke);

    await waitFor(() => {
      expect(useHookTrustStore.getState().approvalsByRootId['db-a']).toBeUndefined();
    });
  });

  // KILL CHAIN (remove→re-add): the re-added root gets a FRESH adapter id
  // (`root-a2`) but path-matches the KEPT DB row (`db-a`). The panel MUST key
  // status/approve/revoke by the review's `dbRootId`, so a prior approval shows
  // as trusted and Revoke removes the LIVE grant the server matches on — not a
  // dead adapter-id entry (the old fail-OPEN no-op).
  it('reflects and revokes the live grant on a re-added root (adapter id diverged from DB id)', async () => {
    // Grant persisted under the DB id from the first mount.
    useHookTrustStore.getState().approveRoot('db-a', 'hash-1');
    const readdedRoots = [{ absPath: '/ws/a', displayName: 'Workspace A', rootId: 'root-a2' }];
    mockBridge({
      content: '{}',
      dbRootId: 'db-a',
      exists: true,
      path: '/ws/a/.brainstrike/hooks.json',
      rootId: 'root-a2',
      sha256: 'hash-1',
    });
    render(<HooksSettingsSection roots={readdedRoots} />);

    // The re-added row (adapter id root-a2) reads the DB-keyed grant → Trusted.
    const revoke = await screen.findByTestId('hooks-revoke-root-a2');
    fireEvent.click(revoke);

    // Revoke removes the LIVE grant (db-a) — the exact entry the server attests.
    await waitFor(() => {
      expect(useHookTrustStore.getState().approvalsByRootId['db-a']).toBeUndefined();
    });
  });

  it('shows "changed" when the approved hash no longer matches disk', async () => {
    useHookTrustStore.getState().approveRoot('db-a', 'old-hash');
    mockBridge({
      content: '{}',
      dbRootId: 'db-a',
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

  it('shows a neutral checking state while the review is in flight (never a placeholder "Untrusted")', async () => {
    let resolveReview: (review: ProjectHooksReview) => void = () => {
      // assigned synchronously below
    };
    (window as Window & { hooks?: unknown }).hooks = {
      getProjectHooksForReview: vi.fn(
        () =>
          new Promise<ProjectHooksReview>((resolve) => {
            resolveReview = resolve;
          })
      ),
    };
    render(<HooksSettingsSection roots={roots} />);

    // In flight: the security-meaningful "Untrusted" badge must NOT be shown as a
    // placeholder; a neutral "Checking…" state is shown instead.
    expect(await screen.findByText(/Checking/)).not.toBeNull();
    expect(screen.queryByText('Untrusted')).toBeNull();
    // …and no action control either. A disabled placeholder Approve would swallow
    // a press (React drops click listeners on disabled buttons) and would make
    // `findByTestId('hooks-approve-*')` resolve on a row that cannot yet act.
    expect(screen.queryByTestId('hooks-approve-root-a')).toBeNull();
    expect(screen.queryByTestId('hooks-revoke-root-a')).toBeNull();

    resolveReview({
      content: '{}',
      dbRootId: 'db-a',
      exists: true,
      path: '/ws/a/.brainstrike/hooks.json',
      rootId: 'root-a',
      sha256: 'hash-1',
    });
    await screen.findByTestId('hooks-approve-root-a');
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
