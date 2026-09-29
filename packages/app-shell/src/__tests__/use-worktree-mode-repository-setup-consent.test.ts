/**
 * Repository setup script consent (BST-1455): the create sheet's Allow/Skip
 * gate, the standing-decision persistence, hash-staleness re-prompting, and
 * the branch-menu "Switch in new worktree" path, which never opens the sheet
 * and must still resolve the same consent state — split out of
 * `use-worktree-mode.test.ts` to keep both files under the line-count ceiling.
 */
import {
  __resetWorktreeSetupConsentStoreForTests,
  useWorktreeSetupConsentStore,
} from '@brainstrike/app-state/stores/worktree-setup-consent-store';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addRootByPathSpy,
  createContextSpy,
  createSpy,
  getSettingsSpy,
  listSpy,
  loggerErrorSpy,
  toastSpy,
} = vi.hoisted(() => ({
  addRootByPathSpy: vi.fn(),
  createContextSpy: vi.fn(),
  createSpy: vi.fn(),
  getSettingsSpy: vi.fn(),
  listSpy: vi.fn(),
  loggerErrorSpy: vi.fn(),
  toastSpy: vi.fn(),
}));

vi.mock('../worktrees/worktrees-bridge', () => ({
  resolveWorktreesBridge: () => ({
    adopt: vi.fn(),
    archive: vi.fn(),
    checkoutStatus: vi.fn(),
    create: createSpy,
    createBranchHere: vi.fn(),
    createContext: createContextSpy,
    getSettings: getSettingsSpy,
    list: listSpy,
    listManagedPaths: vi.fn(),
    restore: vi.fn(),
    setSettings: vi.fn(),
  }),
}));
vi.mock('@brainstrike/logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/logging')>()),
  createLogger: () => ({
    debug: vi.fn(),
    error: loggerErrorSpy,
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  }),
}));
vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileSystem: () => ({
    addRootDirectory: vi.fn(),
    addRootDirectoryByPath: addRootByPathSpy,
  }),
}));
vi.mock('@brainstrike/ui', () => ({ toast: toastSpy }));

import { useWorktreeMode } from '../hooks/use-worktree-mode';

const onHandOffToLocal = vi.fn(() => Promise.resolve());
const onSelectWorktree = vi.fn(() => Promise.resolve());

const ARGS = {
  checkout: { branch: null, mode: 'local' as const, worktreeId: null, worktreePath: null },
  firstRequestState: 'unsent' as const,
  isRepository: true,
  onHandOffToLocal,
  onSelectWorktree,
  primaryRootId: 'r-1',
  primaryRootPath: '/work/app',
  runId: null,
  threadId: 'thread-1',
};

const CREATE_REQUEST = {
  baseRef: 'main',
  branch: { name: 'bs/bright-fox' },
  name: 'bright-fox',
} as const;

const REPOSITORY_SETUP = {
  repositoryId: '/work/app/.git',
  repositoryPath: '/work/app',
  scriptPath: '/work/app/.brainstrike/worktree-setup.sh',
  scriptSha256: 'hash-current',
} as const;

describe('useWorktreeMode repository setup consent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetWorktreeSetupConsentStoreForTests();
    getSettingsSpy.mockResolvedValue({
      ok: true,
      value: {
        isDefaultDirectory: true,
        managedDirectory: '/home/me/.brainstrike/worktrees',
        setupCommand: null,
      },
    });
    listSpy.mockResolvedValue({ ok: true, value: [] });
    createContextSpy.mockResolvedValue({
      ok: true,
      value: {
        managedParentPath: '/managed/app-slug',
        repositorySetup: null,
        suggestedName: 'bright-fox',
      },
    });
    createSpy.mockResolvedValue({
      ok: true,
      value: {
        setup: {
          copiedPaths: [],
          output: '',
          reason: null,
          skippedCopies: [],
          status: 'none',
          truncated: false,
        },
        worktree: {
          archivedAt: null,
          archiveSnapshotRef: null,
          baseRef: 'main',
          branch: 'bs/bright-fox',
          createdAt: '2026-08-25T00:00:00.000Z',
          createdBy: 'user',
          id: 'w-1',
          path: '/managed/app/bright-fox',
          repoCommonDir: '/repo/.git',
          runId: null,
          setupOutput: null,
          setupReason: null,
          setupStatus: 'none',
          threadId: null,
        },
      },
    });
    addRootByPathSpy.mockResolvedValue({ rootId: 'w-1' });
  });

  it('requires a repository setup decision, forwards the durable approval, and keeps the consent block visible with the standing choice reflected', async () => {
    createContextSpy.mockResolvedValueOnce({
      ok: true,
      value: {
        managedParentPath: '/managed/app-slug',
        repositorySetup: REPOSITORY_SETUP,
        suggestedName: 'bright-fox',
      },
    });
    const { result } = renderHook(() => useWorktreeMode(ARGS));

    await act(async () => {
      await result.current?.onOpenCreateSheet();
    });
    expect(result.current?.repositorySetupConsent).toMatchObject({
      decision: null,
      repositoryPath: '/work/app',
    });

    act(() => {
      result.current?.repositorySetupConsent?.onDecision('approved');
    });
    // A decision no longer instantly hides the block — it stays visible with
    // the standing choice reflected, so a misclick is a one-click change
    // (the OTHER button) rather than durable until a full revoke.
    expect(result.current?.repositorySetupConsent).toMatchObject({
      decision: 'approved',
      repositoryPath: '/work/app',
    });
    await act(async () => {
      await result.current?.onCreate(CREATE_REQUEST);
    });

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repositorySetupDecision: {
          decision: 'approved',
          repositoryId: '/work/app/.git',
          scriptSha256: 'hash-current',
        },
      })
    );
  });

  it('suppresses the prompt and forwards a persisted denial for the same repository', async () => {
    useWorktreeSetupConsentStore.getState().decide('/work/app/.git', 'denied', 'hash-current');
    createContextSpy.mockResolvedValueOnce({
      ok: true,
      value: {
        managedParentPath: '/managed/app-slug',
        repositorySetup: REPOSITORY_SETUP,
        suggestedName: 'bright-fox',
      },
    });
    const { result } = renderHook(() => useWorktreeMode(ARGS));

    await act(async () => {
      await result.current?.onOpenCreateSheet();
    });
    expect(result.current?.repositorySetupConsent).toMatchObject({ decision: 'denied' });
    await act(async () => {
      await result.current?.onCreate(CREATE_REQUEST);
    });

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repositorySetupDecision: {
          decision: 'denied',
          repositoryId: '/work/app/.git',
          scriptSha256: 'hash-current',
        },
      })
    );
  });

  it('treats a decision pinned to a DIFFERENT script hash as stale and re-prompts', async () => {
    useWorktreeSetupConsentStore.getState().decide('/work/app/.git', 'approved', 'hash-old');
    createContextSpy.mockResolvedValueOnce({
      ok: true,
      value: {
        managedParentPath: '/managed/app-slug',
        // The script changed since the decision was made (pull / branch
        // switch / rebase) — main now reports a different hash.
        repositorySetup: { ...REPOSITORY_SETUP, scriptSha256: 'hash-new' },
        suggestedName: 'bright-fox',
      },
    });
    const { result } = renderHook(() => useWorktreeMode(ARGS));

    await act(async () => {
      await result.current?.onOpenCreateSheet();
    });

    expect(result.current?.repositorySetupConsent).toMatchObject({ decision: null });
  });

  it('the branch-menu create path (no create sheet opened) still forwards an already-standing decision', async () => {
    useWorktreeSetupConsentStore.getState().decide('/work/app/.git', 'approved', 'hash-current');
    createContextSpy.mockResolvedValue({
      ok: true,
      value: {
        managedParentPath: '/managed/app-slug',
        repositorySetup: REPOSITORY_SETUP,
        suggestedName: 'bright-fox',
      },
    });
    const { result } = renderHook(() => useWorktreeMode(ARGS));
    await waitFor(() => expect(result.current?.createDisabledReason).toBeNull());

    // Deliberately never calling onOpenCreateSheet: this is the branch menu's
    // "Switch in new worktree" shape, which calls mode.onCreate directly.
    await act(async () => {
      await result.current?.onCreate(CREATE_REQUEST);
    });

    expect(createContextSpy).toHaveBeenCalledWith({ rootId: 'r-1' });
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        repositorySetupDecision: {
          decision: 'approved',
          repositoryId: '/work/app/.git',
          scriptSha256: 'hash-current',
        },
      })
    );
  });

  it('the branch-menu create path with NO standing decision creates the worktree without silently running setup', async () => {
    createContextSpy.mockResolvedValue({
      ok: true,
      value: {
        managedParentPath: '/managed/app-slug',
        repositorySetup: REPOSITORY_SETUP,
        suggestedName: 'bright-fox',
      },
    });
    const { result } = renderHook(() => useWorktreeMode(ARGS));
    await waitFor(() => expect(result.current?.createDisabledReason).toBeNull());

    await act(async () => {
      await result.current?.onCreate(CREATE_REQUEST);
    });

    // No decision is forwarded — main's own "consent required" reason is what
    // keeps this fail-closed to a VISIBLE skip, never a silent run.
    expect(createSpy).toHaveBeenCalledWith(
      expect.not.objectContaining({ repositorySetupDecision: expect.anything() })
    );
  });
});
