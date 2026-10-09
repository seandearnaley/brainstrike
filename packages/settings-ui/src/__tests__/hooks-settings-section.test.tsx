import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { HooksSettingsSection } = await import('../settings/system/hooks-settings-section');

interface ProjectHooksReview {
  approvedSha256?: string;
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

const onDisk = (rootId: string, sha256: string): ProjectHooksReview => ({
  content: '{}',
  dbRootId: 'db-a',
  exists: true,
  path: '/ws/a/.brainstrike/hooks.json',
  rootId,
  sha256,
});

/**
 * Main's bridge over the agent host: a review reports the hash the host
 * trusts the root at, and trust/untrust change it by the root's path. The
 * production bridge is `ipcRenderer.invoke` — a real IPC round-trip that can
 * NEVER settle within the caller's microtask checkpoint. Resolving on a
 * macrotask delivers that runtime shape: a row is guaranteed to render its
 * in-flight "Checking…" state at least once before the review lands.
 */
function mockBridge(review: ProjectHooksReview, options: { refuse?: string } = {}) {
  let approvedSha256: string | undefined = review.approvedSha256;
  const later = <T,>(value: () => T): Promise<T> =>
    new Promise((resolve) => {
      setTimeout(() => resolve(value()), 0);
    });
  const bridge = {
    getProjectHooksForReview: vi.fn((rootId: string) =>
      later(() => {
        const { approvedSha256: _initial, ...current } = review;
        return approvedSha256 === undefined
          ? { ...current, rootId }
          : { ...current, approvedSha256, rootId };
      })
    ),
    trustProjectHooks: vi.fn((_absPath: string, sha256: string) => {
      if (options.refuse) {
        return Promise.reject(new Error(options.refuse));
      }
      return later(() => {
        approvedSha256 = sha256;
      });
    }),
    untrustProjectHooks: vi.fn((_absPath: string) =>
      later(() => {
        approvedSha256 = undefined;
      })
    ),
  };
  (window as Window & { hooks?: unknown }).hooks = bridge;
  return bridge;
}

afterEach(() => {
  Reflect.deleteProperty(window as Window & { hooks?: unknown }, 'hooks');
});

describe('HooksSettingsSection', () => {
  it('shows an empty state when no roots are mounted', () => {
    render(<HooksSettingsSection roots={[]} />);
    expect(screen.getByTestId('hooks-no-roots')).not.toBeNull();
  });

  it('approves a root through the host at the reviewed hash, then shows it trusted', async () => {
    const bridge = mockBridge(onDisk('root-a', 'hash-1'));
    render(<HooksSettingsSection roots={roots} />);
    expect(await screen.findByText('Untrusted')).not.toBeNull();

    fireEvent.click(await screen.findByTestId('hooks-approve-root-a'));

    // After approval the host trusts the root → a Revoke button appears.
    expect(await screen.findByTestId('hooks-revoke-root-a')).not.toBeNull();
    expect(screen.getByText('Trusted')).not.toBeNull();
    expect(bridge.trustProjectHooks).toHaveBeenCalledWith('/ws/a', 'hash-1');
  });

  it('revokes a trusted root through the host', async () => {
    const bridge = mockBridge({ ...onDisk('root-a', 'hash-1'), approvedSha256: 'hash-1' });
    render(<HooksSettingsSection roots={roots} />);

    fireEvent.click(await screen.findByTestId('hooks-revoke-root-a'));

    expect(await screen.findByTestId('hooks-approve-root-a')).not.toBeNull();
    expect(screen.getByText('Untrusted')).not.toBeNull();
    expect(bridge.untrustProjectHooks).toHaveBeenCalledWith('/ws/a');
  });

  // A re-added root gets a FRESH adapter id (`root-a2`) but path-matches the
  // KEPT DB row: Main reads the host's trust for that row, so a prior approval
  // shows as trusted, and Revoke names the root by its path, never an id.
  it('reflects and revokes the host trust on a re-added root (adapter id diverged from DB id)', async () => {
    const bridge = mockBridge({ ...onDisk('root-a2', 'hash-1'), approvedSha256: 'hash-1' });
    const readdedRoots = [{ absPath: '/ws/a', displayName: 'Workspace A', rootId: 'root-a2' }];
    render(<HooksSettingsSection roots={readdedRoots} />);

    fireEvent.click(await screen.findByTestId('hooks-revoke-root-a2'));

    await waitFor(() => {
      expect(bridge.untrustProjectHooks).toHaveBeenCalledWith('/ws/a');
    });
    expect(await screen.findByTestId('hooks-approve-root-a2')).not.toBeNull();
  });

  it('shows "changed" when the trusted hash no longer matches disk', async () => {
    mockBridge({ ...onDisk('root-a', 'new-hash'), approvedSha256: 'old-hash' });
    render(<HooksSettingsSection roots={roots} />);

    expect(await screen.findByText(/Changed — re-approve/)).not.toBeNull();
    // A changed root offers Approve (to re-pin), not Revoke.
    expect(screen.getByTestId('hooks-approve-root-a')).not.toBeNull();
  });

  it('shows the host’s reason when it refuses an approval, and the root stays untrusted', async () => {
    mockBridge(onDisk('root-a', 'hash-1'), {
      refuse: '/ws/a/.brainstrike/hooks.json changed since it was reviewed; review it again',
    });
    render(<HooksSettingsSection roots={roots} />);

    fireEvent.click(await screen.findByTestId('hooks-approve-root-a'));

    expect((await screen.findByTestId('hooks-error-root-a')).textContent).toBe(
      '/ws/a/.brainstrike/hooks.json changed since it was reviewed; review it again'
    );
    expect(screen.getByText('Untrusted')).not.toBeNull();
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

    resolveReview(onDisk('root-a', 'hash-1'));
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
