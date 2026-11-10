/**
 * Skill slash-command hook tests: capability gating by the host's discovery,
 * user-invocable + enabled filtering (skills preferences store), and the
 * directive-staging execute contract (writes `:skill[name]` into the composer
 * with the trigger text stripped — never auto-sends).
 */

import { useSkillsPreferencesStore } from '@brainstrike/app-state/stores/skills-preferences-store';
import type { SkillsScanResultSummary } from '@brainstrike/assistant-contract';
import { act } from '@brainstrike/test-utils/react-act';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAssistantComposerCommandStore } from '../assistant-composer-command-store';
import type { AssistantHostWorkspaceDiscovery } from '../assistant-thread-host-context';
import { useSkillSlashCommands } from '../use-skill-slash-commands';
import { notifyWorkspaceTrustChanged } from '../workspace-trust/workspace-trust-revision';

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

// The agent host's skills scan; absent without a host (web).
const hostState: {
  host: { readonly workspaceDiscovery: AssistantHostWorkspaceDiscovery } | undefined;
} = { host: undefined };
vi.mock('../assistant-thread-host-context', () => ({
  useAssistantThreadHost: () => hostState.host,
}));

function setBridge(result: SkillsScanResultSummary | null): void {
  hostState.host = result
    ? {
        workspaceDiscovery: {
          listCommands: () => Promise.reject(new Error('Commands are not under test')),
          listTrust: () => Promise.reject(new Error('Trust is not under test')),
          listTrustedLocations: () => Promise.reject(new Error('Trust is not under test')),
          removeTrustedLocation: () => Promise.reject(new Error('Trust is not under test')),
          scanSkills: () => Promise.resolve(result),
          setTrust: () => Promise.reject(new Error('Trust is not under test')),
        },
      }
    : undefined;
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
  toastSpy.mockClear();
});

afterEach(() => {
  hostState.host = undefined;
  vi.restoreAllMocks();
});

const THREAD = 'thread-1';

describe('useSkillSlashCommands', () => {
  it('returns an empty list without a host (web capability gating)', () => {
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

  it('replaces a mid-draft trigger IN PLACE, preserving trailing text', async () => {
    setBridge({ entries: [okEntry('pdf-processing')] });
    useAssistantComposerCommandStore
      .getState()
      .recordDraft(THREAD, 'review /skill:pdf-processing then summarize the findings');

    const { result } = renderHook(() => useSkillSlashCommands(THREAD));
    await waitFor(() => expect(result.current).toHaveLength(1));

    act(() => {
      result.current[0]?.execute();
    });

    const queued = useAssistantComposerCommandStore.getState().commandsByThreadId[THREAD]?.[0];
    expect(queued?.text).toBe('review :skill[pdf-processing] then summarize the findings');
  });

  it('replaces a PARTIAL typed trigger (popover fuzzy match before the id is complete)', async () => {
    setBridge({ entries: [okEntry('pdf-processing')] });
    useAssistantComposerCommandStore.getState().recordDraft(THREAD, 'please /skill:pd');

    const { result } = renderHook(() => useSkillSlashCommands(THREAD));
    await waitFor(() => expect(result.current).toHaveLength(1));

    act(() => {
      result.current[0]?.execute();
    });

    const queued = useAssistantComposerCommandStore.getState().commandsByThreadId[THREAD]?.[0];
    expect(queued?.text).toContain(':skill[pdf-processing]');
    expect(queued?.text).not.toContain('/skill:pd');
  });

  it("reloads the skills once the person answers a folder's trust (ADR-0032)", async () => {
    // The host lists a folder's skills only once the person trusts it.
    let entries: SkillsScanResultSummary['entries'] = [];
    const scanSkills = vi.fn(() => Promise.resolve({ entries }));
    hostState.host = {
      workspaceDiscovery: {
        listCommands: () => Promise.reject(new Error('Commands are not under test')),
        listTrust: () => Promise.reject(new Error('Trust is not under test')),
        listTrustedLocations: () => Promise.reject(new Error('Trust is not under test')),
        removeTrustedLocation: () => Promise.reject(new Error('Trust is not under test')),
        scanSkills,
        setTrust: () => Promise.reject(new Error('Trust is not under test')),
      },
    };
    const { result } = renderHook(() => useSkillSlashCommands(THREAD));
    await waitFor(() => expect(scanSkills).toHaveBeenCalledTimes(1));
    expect(result.current).toEqual([]);

    entries = [okEntry('pdf-processing')];
    act(() => {
      notifyWorkspaceTrustChanged();
    });

    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0]?.id).toBe('skill:pdf-processing');
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
