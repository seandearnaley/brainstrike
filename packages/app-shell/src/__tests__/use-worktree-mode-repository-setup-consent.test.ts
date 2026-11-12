/**
 * Repository setup script consent (ADR-0034): the host keeps the person's
 * answer, so the create sheet shows the host's standing answer, Allow and Skip
 * record one with the host for the script the sheet showed, and a create
 * carries no answer of its own — the host reads its record for every create,
 * including the branch menu's "Switch in a new worktree", which never opens
 * the sheet. Split out of `use-worktree-mode.test.ts` to keep both files under
 * the line-count ceiling.
 */
import { refusal } from '@brainstrike/assistant-contract/boundary-failure';
import { act } from '@brainstrike/test-utils/react-act';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorktreeMode } from '../hooks/use-worktree-mode';
import { stubWorktreesBridge, workspaceGitWrapper } from './helpers/workspace-git-services-wrapper';

const {
  addRootByPathSpy,
  createContextSpy,
  createSpy,
  decideSetupConsentSpy,
  getSettingsSpy,
  listSpy,
  toastSpy,
} = vi.hoisted(() => ({
  addRootByPathSpy: vi.fn(),
  createContextSpy: vi.fn(),
  createSpy: vi.fn(),
  decideSetupConsentSpy: vi.fn(),
  getSettingsSpy: vi.fn(),
  listSpy: vi.fn(),
  toastSpy: vi.fn(),
}));

const wrapper = workspaceGitWrapper({
  worktrees: stubWorktreesBridge({
    create: createSpy,
    createContext: createContextSpy,
    decideSetupConsent: decideSetupConsentSpy,
    getSettings: getSettingsSpy,
    list: listSpy,
  }),
});
vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileSystem: () => ({
    addRootDirectory: vi.fn(),
    addRootDirectoryByPath: addRootByPathSpy,
  }),
}));
vi.mock('@brainstrike/ui', () => ({ toast: toastSpy }));

const ARGS = {
  checkout: { branch: null, mode: 'local' as const, worktreeId: null, worktreePath: null },
  isRepository: true,
  onHandOffToLocal: vi.fn(() => Promise.resolve()),
  onSelectWorktree: vi.fn(() => Promise.resolve()),
  primaryRootId: 'r-1',
  primaryRootPath: '/work/app',
  statusFailure: null,
  threadId: 'thread-1',
  threadState: 'idle' as const,
  uncommittedChanges: false,
};

const CREATE_REQUEST = {
  baseRef: 'main',
  branch: { name: 'bs/bright-fox' },
  name: 'bright-fox',
} as const;

const REPOSITORY_SETUP = {
  decision: null,
  repositoryId: '/work/app/.git',
  repositoryPath: '/work/app',
  scriptPath: '/work/app/.brainstrike/worktree-setup.sh',
  scriptSha256: 'a'.repeat(64),
} as const;

/** The host's create-sheet context, with its standing answer for the script. */
function createContext(decision: 'approved' | 'denied' | null) {
  return {
    ok: true,
    value: {
      managedParentPath: '/managed/app-slug',
      repositorySetup: { ...REPOSITORY_SETUP, decision },
      suggestedName: 'bright-fox',
    },
  };
}

describe('useWorktreeMode repository setup consent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettingsSpy.mockResolvedValue({
      ok: true,
      value: {
        isDefaultDirectory: true,
        managedDirectory: '/home/me/.brainstrike/worktrees',
        setupCommand: null,
      },
    });
    listSpy.mockResolvedValue({ ok: true, value: [] });
    createSpy.mockResolvedValue({
      ok: true,
      value: {
        setup: {
          copiedPaths: [],
          output: '',
          reason: null,
          skippedCopies: [],
          status: 'succeeded',
          truncated: false,
        },
        worktree: {
          archivedAt: null,
          archiveSnapshotRef: null,
          baseRef: 'main',
          branch: 'bs/bright-fox',
          createdAt: '2026-11-12T00:00:00.000Z',
          createdBy: 'user',
          id: 'w-1',
          path: '/managed/app/bright-fox',
          repoCommonDir: '/work/app/.git',
          runId: null,
          setupOutput: null,
          setupReason: null,
          setupStatus: 'succeeded',
          threadId: null,
        },
      },
    });
    addRootByPathSpy.mockResolvedValue({ rootId: 'w-1' });
  });

  it('shows the host’s standing answer for the script when the sheet opens', async () => {
    createContextSpy.mockResolvedValueOnce(createContext('denied'));
    const { result } = renderHook(() => useWorktreeMode(ARGS), { wrapper });

    await act(async () => {
      await result.current?.onOpenCreateSheet();
    });

    expect(result.current?.repositorySetupConsent).toMatchObject({
      decision: 'denied',
      repositoryPath: '/work/app',
      scriptPath: '/work/app/.brainstrike/worktree-setup.sh',
    });
  });

  it('records Allow with the host for the script the sheet showed, then shows the host’s answer', async () => {
    createContextSpy
      .mockResolvedValueOnce(createContext(null))
      .mockResolvedValueOnce(createContext('approved'));
    decideSetupConsentSpy.mockResolvedValueOnce({
      ok: true,
      value: {
        decidedAt: '2026-11-12T00:00:00.000Z',
        decision: 'approved',
        repositoryId: '/work/app/.git',
        scriptSha256: REPOSITORY_SETUP.scriptSha256,
      },
    });
    const { result } = renderHook(() => useWorktreeMode(ARGS), { wrapper });
    await act(async () => {
      await result.current?.onOpenCreateSheet();
    });
    expect(result.current?.repositorySetupConsent).toMatchObject({ decision: null });

    await act(async () => {
      await result.current?.repositorySetupConsent?.onDecision('approved');
    });

    expect(decideSetupConsentSpy).toHaveBeenCalledWith({
      decision: 'approved',
      rootId: 'r-1',
      scriptSha256: REPOSITORY_SETUP.scriptSha256,
    });
    expect(result.current?.repositorySetupConsent).toMatchObject({ decision: 'approved' });
  });

  it('rejects with the host’s reason when it refuses the answer, and keeps asking', async () => {
    createContextSpy.mockResolvedValueOnce(createContext(null));
    decideSetupConsentSpy.mockResolvedValueOnce({
      error: refusal({
        category: 'conflict',
        code: 'worktree.setup-consent-refused',
        message:
          '/work/app/.brainstrike/worktree-setup.sh changed since it was shown; review it again.',
      }),
      ok: false,
    });
    const { result } = renderHook(() => useWorktreeMode(ARGS), { wrapper });
    await act(async () => {
      await result.current?.onOpenCreateSheet();
    });

    await act(async () => {
      await expect(result.current?.repositorySetupConsent?.onDecision('approved')).rejects.toThrow(
        'changed since it was shown; review it again.'
      );
    });

    expect(result.current?.repositorySetupConsent).toMatchObject({ decision: null });
  });

  it('creates from the branch menu with no answer of its own: the host reads its record', async () => {
    const { result } = renderHook(() => useWorktreeMode(ARGS), { wrapper });
    await waitFor(() => expect(result.current?.createDisabledReason).toBeNull());

    // The branch menu's "Switch in a new worktree" never opens the sheet.
    await act(async () => {
      await result.current?.onCreate(CREATE_REQUEST);
    });

    expect(createSpy).toHaveBeenCalledWith({
      baseRef: 'main',
      branch: { name: 'bs/bright-fox' },
      createdBy: 'user',
      name: 'bright-fox',
      rootId: 'r-1',
    });
    expect(toastSpy).not.toHaveBeenCalled();
  });
});
