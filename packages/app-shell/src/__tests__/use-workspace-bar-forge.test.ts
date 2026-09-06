import type { AssistantThreadRepository } from '@brainstrike/assistant-data';
import type { WorkspaceBarCheckout } from '@brainstrike/assistant-ui';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceBarForge } from '../hooks/use-workspace-bar-forge';

const { clipboardWriteText, forgePrSpy, loggerMock, toastSpy } = vi.hoisted(() => ({
  clipboardWriteText: vi.fn(),
  forgePrSpy: vi.fn(),
  loggerMock: {
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  },
  toastSpy: vi.fn(),
}));

vi.mock('../hooks/use-thread-forge-pr', () => ({ useThreadForgePr: forgePrSpy }));
vi.mock('@brainstrike/logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/logging')>()),
  createLogger: () => loggerMock,
}));
vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  toast: toastSpy,
}));
vi.mock('@brainstrike/context-actions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/context-actions')>()),
  createClipboardService: () => ({ writeText: clipboardWriteText }),
}));

const checkout: WorkspaceBarCheckout = { ahead: 0, behind: 0, branch: 'main', dirty: false };
const updateThreadMetadata = vi.fn(async () => {});
const assistantThreadRepository = {} as unknown as AssistantThreadRepository;

const pullRequest = {
  checks: [],
  checksRollup: 'none' as const,
  headSha: 'sha',
  isDraft: false,
  number: 7,
  reviewDecision: null,
  state: 'open' as const,
  title: 't',
  url: 'https://example.test/pull/7',
};

function baseArgs(
  overrides: Partial<Parameters<typeof useWorkspaceBarForge>[0]> = {}
): Parameters<typeof useWorkspaceBarForge>[0] {
  return {
    assistantThreadRepository,
    checkout,
    forgePrWatched: true,
    memoryResourceId: 'workspace-a',
    platform: null,
    primaryRootId: 'root-1',
    selectedMemoryThreadId: 'thread-1',
    updateThreadMetadata,
    ...overrides,
  };
}

beforeEach(() => {
  forgePrSpy.mockReset();
  forgePrSpy.mockReturnValue({ diagnostic: null, refresh: vi.fn(), status: null });
  clipboardWriteText.mockReset();
  clipboardWriteText.mockResolvedValue({ ok: true });
  toastSpy.mockClear();
  loggerMock.error.mockClear();
  updateThreadMetadata.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useWorkspaceBarForge', () => {
  // M2 (opus review): a non-repository primary root (checkout undefined) must
  // never be handed to useThreadForgePr — that would manufacture a diagnostic
  // with nowhere to render (BranchChip, its only home, itself requires
  // `checkout`).
  it('never probes forge when the primary root is not a confirmed repository', () => {
    renderHook(() => useWorkspaceBarForge(baseArgs({ checkout: undefined })));
    expect(forgePrSpy).toHaveBeenCalledWith(null);
  });

  it('probes forge with the primary root once checkout confirms a repository', () => {
    renderHook(() => useWorkspaceBarForge(baseArgs()));
    expect(forgePrSpy).toHaveBeenCalledWith('root-1');
  });

  // L1: a stale observation with no last-known pull request has no checks to
  // ask the agent to fix.
  it('leaves onAskAgentToFixChecks undefined for a stale observation with no last-known pull request', () => {
    forgePrSpy.mockReturnValue({
      diagnostic: 'gh-unauthenticated: run `gh auth login`.',
      refresh: vi.fn(),
      status: {
        failure: {
          detail: 'gh-unauthenticated: run `gh auth login`.',
          reason: 'gh-unauthenticated',
        },
        kind: 'stale',
        observedAt: '2026-08-24T00:00:00.000Z',
        pullRequest: null,
      },
    });
    const { result } = renderHook(() => useWorkspaceBarForge(baseArgs()));
    expect(result.current?.onAskAgentToFixChecks).toBeUndefined();
  });

  // F4: onCopyUrl used to alias onCopyPath, so a failed Copy URL toasted
  // "Copy path failed" with the URL logged under a `path` field.
  it('surfaces a failed Copy URL with its own title, never "Copy path failed"', async () => {
    clipboardWriteText.mockResolvedValue({
      error: 'Desktop clipboard bridge rejected the write',
      ok: false,
    });
    forgePrSpy.mockReturnValue({
      diagnostic: null,
      refresh: vi.fn(),
      status: { kind: 'pr', observedAt: '2026-08-24T00:00:00.000Z', pullRequest },
    });
    const { result } = renderHook(() => useWorkspaceBarForge(baseArgs()));
    await act(async () => {
      result.current?.onCopyUrl('https://example.test/pull/7');
    });
    expect(toastSpy).toHaveBeenCalledWith({
      description: 'Desktop clipboard bridge rejected the write',
      title: 'Copy URL failed',
      variant: 'destructive',
    });
  });

  // L4: no thread to persist the toggle against means the PR chip hides the
  // Watch item entirely — never a stub that can only toast an error.
  it('leaves onWatchChange undefined when there is no thread to persist it against', () => {
    forgePrSpy.mockReturnValue({
      diagnostic: null,
      refresh: vi.fn(),
      status: { kind: 'none', observedAt: '2026-08-24T00:00:00.000Z' },
    });
    const { result } = renderHook(() =>
      useWorkspaceBarForge(baseArgs({ selectedMemoryThreadId: undefined }))
    );
    expect(result.current?.onWatchChange).toBeUndefined();
  });
});
