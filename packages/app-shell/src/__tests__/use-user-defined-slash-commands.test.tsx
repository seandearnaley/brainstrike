import type { UserSlashCommandsListResult } from '@brainstrike/assistant-contract';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The hook subscribes to activeRootIds purely as a refresh trigger.
const storeState = { activeRootIds: ['root-1'] as string[] };
vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileExplorerStoreSelector: <T,>(selector: (state: typeof storeState) => T): T =>
    selector(storeState),
}));

import { useAssistantComposerCommandStore } from '../assistant-composer-command-store';
import { useUserDefinedSlashCommands } from '../use-user-defined-slash-commands';

interface MutableWindow {
  userCommands?: { list?: () => Promise<UserSlashCommandsListResult> } | undefined;
}

function asMutableWindow(): MutableWindow {
  return window as unknown as MutableWindow;
}

function setBridge(result: UserSlashCommandsListResult | null): void {
  asMutableWindow().userCommands = result ? { list: () => Promise.resolve(result) } : undefined;
}

beforeEach(() => {
  useAssistantComposerCommandStore.getState().reset();
});

afterEach(() => {
  asMutableWindow().userCommands = undefined;
  vi.restoreAllMocks();
});

const THREAD = 'thread-1';

describe('useUserDefinedSlashCommands', () => {
  it('returns an empty list when the desktop bridge is absent (web capability gating)', () => {
    setBridge(null);
    const { result } = renderHook(() => useUserDefinedSlashCommands(THREAD));
    expect(result.current).toEqual([]);
  });

  it('loads and maps scanned commands into SlashCommand entries', async () => {
    setBridge({
      commands: [
        { id: 'review', label: 'Review', sourceRootId: 'root-1', template: 'Review $ARGUMENTS' },
      ],
      roots: [{ displayName: 'Proj', id: 'root-1' }],
    });
    const { result } = renderHook(() => useUserDefinedSlashCommands(THREAD));
    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0]?.id).toBe('review');
    expect(result.current[0]?.label).toBe('Review');
  });

  it('execute() expands the live composer args and writes the expansion into the composer (never sends)', async () => {
    setBridge({
      commands: [
        { id: 'review', label: 'Review', sourceRootId: 'root-1', template: 'Review: $ARGUMENTS' },
      ],
      roots: [{ displayName: 'Proj', id: 'root-1' }],
    });
    // Live composer text captured before selection (the "Commands with Arguments" pattern).
    useAssistantComposerCommandStore.getState().recordDraft(THREAD, '/review src/foo.ts');

    const { result } = renderHook(() => useUserDefinedSlashCommands(THREAD));
    await waitFor(() => expect(result.current).toHaveLength(1));

    act(() => {
      result.current[0]?.execute();
    });

    const queued = useAssistantComposerCommandStore.getState().commandsByThreadId[THREAD];
    expect(queued).toHaveLength(1);
    expect(queued?.[0]).toMatchObject({ mode: 'replace', text: 'Review: src/foo.ts' });
  });

  it('binds @path template tokens to the source root id of a root-scoped command', async () => {
    setBridge({
      commands: [{ id: 'ctx', label: 'ctx', sourceRootId: 'root-9', template: 'See @src/a.ts' }],
      roots: [
        { displayName: 'A', id: 'root-1' },
        { displayName: 'B', id: 'root-9' },
      ],
    });
    useAssistantComposerCommandStore.getState().recordDraft(THREAD, '/ctx');
    const { result } = renderHook(() => useUserDefinedSlashCommands(THREAD));
    await waitFor(() => expect(result.current).toHaveLength(1));

    act(() => {
      result.current[0]?.execute();
    });

    const queued = useAssistantComposerCommandStore.getState().commandsByThreadId[THREAD];
    expect(queued?.[0]?.text).toBe('See :file[a.ts]{name=root-9::src/a.ts}');
  });

  it('binds a GLOBAL command @path to the single mounted root, and leaves it literal under multi-root', async () => {
    // Single root → bind.
    setBridge({
      commands: [{ id: 'g', label: 'g', template: 'See @x.ts' }],
      roots: [{ displayName: 'Only', id: 'root-solo' }],
    });
    useAssistantComposerCommandStore.getState().recordDraft(THREAD, '/g');
    const single = renderHook(() => useUserDefinedSlashCommands(THREAD));
    await waitFor(() => expect(single.result.current).toHaveLength(1));
    act(() => {
      single.result.current[0]?.execute();
    });
    expect(useAssistantComposerCommandStore.getState().commandsByThreadId[THREAD]?.[0]?.text).toBe(
      'See :file[x.ts]{name=root-solo::x.ts}'
    );

    // Reset + multi-root → leave literal (no silent guessing).
    useAssistantComposerCommandStore.getState().reset();
    setBridge({
      commands: [{ id: 'g', label: 'g', template: 'See @x.ts' }],
      roots: [
        { displayName: 'A', id: 'root-a' },
        { displayName: 'B', id: 'root-b' },
      ],
    });
    useAssistantComposerCommandStore.getState().recordDraft(THREAD, '/g');
    const multi = renderHook(() => useUserDefinedSlashCommands(THREAD));
    await waitFor(() => expect(multi.result.current).toHaveLength(1));
    act(() => {
      multi.result.current[0]?.execute();
    });
    expect(useAssistantComposerCommandStore.getState().commandsByThreadId[THREAD]?.[0]?.text).toBe(
      'See @x.ts'
    );
  });

  it('SECURITY: a shell !`command` in the template is written as inert text (never executed/expanded)', async () => {
    setBridge({
      commands: [
        { id: 'danger', label: 'danger', sourceRootId: 'root-1', template: 'Run !`rm -rf /` now' },
      ],
      roots: [{ displayName: 'Proj', id: 'root-1' }],
    });
    useAssistantComposerCommandStore.getState().recordDraft(THREAD, '/danger');
    const { result } = renderHook(() => useUserDefinedSlashCommands(THREAD));
    await waitFor(() => expect(result.current).toHaveLength(1));
    act(() => {
      result.current[0]?.execute();
    });
    expect(useAssistantComposerCommandStore.getState().commandsByThreadId[THREAD]?.[0]?.text).toBe(
      'Run !`rm -rf /` now'
    );
  });
});
