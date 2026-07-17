/**
 * Skill slash-command hook tests: capability gating by bridge presence,
 * user-invocable + enabled filtering (skills preferences store), and the
 * directive-staging execute contract (writes `:skill[name]` into the composer
 * with the trigger text stripped — never auto-sends).
 */

import type { SkillsScanResultSummary } from '@brainstrike/assistant-contract';
import {
  __resetSkillsPreferencesStoreForTests,
  useSkillsPreferencesStore,
} from '@brainstrike/preferences/stores/skills-preferences-store';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The hook subscribes to activeRootIds purely as a refresh trigger.
const storeState = { activeRootIds: ['root-1'] as string[] };
vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileExplorerStoreSelector: <T,>(selector: (state: typeof storeState) => T): T =>
    selector(storeState),
}));

const toastSpy = vi.fn();
vi.mock('@brainstrike/ui', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

import { useAssistantComposerCommandStore } from '../assistant-composer-command-store';
import { useSkillSlashCommands } from '../use-skill-slash-commands';

interface MutableWindow {
  skills?: { scan?: () => Promise<SkillsScanResultSummary> } | undefined;
}

function asMutableWindow(): MutableWindow {
  return window as unknown as MutableWindow;
}

function setBridge(result: SkillsScanResultSummary | null): void {
  asMutableWindow().skills = result ? { scan: () => Promise.resolve(result) } : undefined;
}

function okEntry(
  name: string,
  overrides: Partial<SkillsScanResultSummary['entries'][number]> = {}
): SkillsScanResultSummary['entries'][number] {
  return {
    absPath: `/proj/.brainstrike/skills/${name}`,
    description: `Use for ${name}.`,
    dirName: name,
    name,
    preferenceKey: `root:root-1:${name}`,
    sourceRootId: 'root-1',
    status: 'ok',
    tier: 'root-brainstrike',
    userInvocable: true,
    ...overrides,
  };
}

beforeEach(() => {
  useAssistantComposerCommandStore.getState().reset();
  __resetSkillsPreferencesStoreForTests();
  toastSpy.mockClear();
});

afterEach(() => {
  asMutableWindow().skills = undefined;
  vi.restoreAllMocks();
});

const THREAD = 'thread-1';

describe('useSkillSlashCommands', () => {
  it('returns an empty list when the desktop bridge is absent (web capability gating)', () => {
    setBridge(null);
    const { result } = renderHook(() => useSkillSlashCommands(THREAD));
    expect(result.current).toEqual([]);
  });

  it('maps user-invocable ok skills into namespaced SlashCommand entries', async () => {
    setBridge({
      entries: [
        okEntry('pdf-processing'),
        okEntry('internal-only', { userInvocable: false }),
        {
          absPath: '/proj/.claude/skills/broken',
          dirName: 'broken',
          errors: ['bad'],
          status: 'invalid',
          tier: 'root-claude',
        },
        okEntry('shadowed-skill', {
          shadowedBy: { absPath: '/x', tier: 'root-brainstrike' },
          status: 'shadowed',
        }),
      ],
    });
    const { result } = renderHook(() => useSkillSlashCommands(THREAD));
    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0]).toMatchObject({
      description: 'Use for pdf-processing.',
      id: 'skill:pdf-processing',
      label: 'pdf-processing',
    });
  });

  it('hides skills disabled in the preferences store and everything when master is off', async () => {
    setBridge({ entries: [okEntry('alpha'), okEntry('beta')] });
    useSkillsPreferencesStore.getState().setSkillDisabled('root:root-1:alpha', true);

    const { result } = renderHook(() => useSkillSlashCommands(THREAD));
    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0]?.id).toBe('skill:beta');

    act(() => {
      useSkillsPreferencesStore.getState().setMasterEnabled(false);
    });
    await waitFor(() => expect(result.current).toHaveLength(0));
  });

  it('execute() stages the :skill[name] directive, stripping the trigger text (never sends)', async () => {
    setBridge({ entries: [okEntry('pdf-processing')] });
    useAssistantComposerCommandStore
      .getState()
      .recordDraft(THREAD, 'please summarize /skill:pdf-processing');

    const { result } = renderHook(() => useSkillSlashCommands(THREAD));
    await waitFor(() => expect(result.current).toHaveLength(1));

    act(() => {
      result.current[0]?.execute();
    });

    const queued = useAssistantComposerCommandStore.getState().commandsByThreadId[THREAD]?.[0];
    expect(queued).toMatchObject({ mode: 'replace' });
    expect(queued?.text).toContain(':skill[pdf-processing]');
    expect(queued?.text).toContain('please summarize');
    expect(queued?.text).not.toContain('/skill:pdf-processing');
  });

  it('surfaces a visible toast when there is no active thread', async () => {
    setBridge({ entries: [okEntry('pdf-processing')] });
    const { result } = renderHook(() => useSkillSlashCommands(undefined));
    await waitFor(() => expect(result.current).toHaveLength(1));
    act(() => {
      result.current[0]?.execute();
    });
    expect(toastSpy).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
  });
});
