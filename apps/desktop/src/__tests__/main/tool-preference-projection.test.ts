import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadToolPreferencesMock, saveToolPreferencesMock } = vi.hoisted(() => ({
  loadToolPreferencesMock: vi.fn(),
  saveToolPreferencesMock: vi.fn(),
}));

vi.mock('@brainstrike/agent', () => ({
  __esModule: true,
  loadToolPreferences: loadToolPreferencesMock,
  mcpToolRegistry: { getAllTools: vi.fn(() => ({})) },
  saveToolPreferences: saveToolPreferencesMock,
}));

vi.mock('electron', () => ({
  __esModule: true,
  app: { getPath: () => 'mock-user-data' },
}));

import { loadToolPreferencesForProjection } from '../../mcp/tool-discovery';

const PREFS_PATH = 'mock-user-data/mcp/tool-preferences.json';

function storedPreferences(preferences: { disabledTools: string[]; enabledTools: string[] }): void {
  loadToolPreferencesMock.mockResolvedValueOnce({
    path: PREFS_PATH,
    preferences: { ...preferences, lastUpdated: 0, version: 1 },
    status: 'loaded' as const,
  });
}

/**
 * Direct unit coverage for the two guards in `loadToolPreferencesForProjection`
 * that the ipc-mcp suite cannot reach. `applyConfigChange` only calls this
 * function when discovery produced at least one tool, which implies the config
 * had servers -- so the "no configured servers" branch is unreachable through
 * the IPC path, and a regression there would be invisible to that suite.
 */
describe('loadToolPreferencesForProjection guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * BST-1621. The empty set means "we were handed no config authority", not
   * "every server was removed". Treating it as the latter retires every stored
   * id at once, which is the whole data loss this function exists to prevent.
   *
   * Nothing else pins this: deleting the guard type-checks clean and leaves the
   * ipc-mcp suite fully green, because that suite can never produce an empty
   * config alongside a non-empty registry.
   */
  it('retires nothing when it is handed no configured servers', async () => {
    storedPreferences({
      disabledTools: ['some-server.dangerous_write'],
      enabledTools: ['some-server.read'],
    });

    const projection = await loadToolPreferencesForProjection(
      new Set(['some-server.read']),
      new Set()
    );

    expect(saveToolPreferencesMock).not.toHaveBeenCalled();
    expect(projection).toEqual({
      disabledTools: [],
      enabledTools: ['some-server.read'],
      status: 'available',
    });
  });

  /**
   * BST-1615 x BST-1621 compose in this order: refuse, then retire. A file we
   * could not read must not be written over, so the retirement question never
   * arises.
   *
   * Today the compiler enforces the ordering on its own -- `preferences` exists
   * only on the `loaded` variant of `ToolPreferencesLoadResult`, so hoisting the
   * retirement block above the fault check does not compile (verified: TS2339).
   * This test is the runtime backstop for the change that would remove that
   * protection: giving `invalid`/`unreadable` a salvaged `preferences` field,
   * which is a plausible shape for the in-session recovery BST-1620 wants. At
   * that moment the ordering becomes breakable silently, and this is what
   * catches it.
   */
  it('refuses the write before retiring anything when the stored file is unreadable', async () => {
    loadToolPreferencesMock.mockResolvedValueOnce({
      path: PREFS_PATH,
      reason: 'EACCES: permission denied',
      status: 'unreadable' as const,
    });

    const projection = await loadToolPreferencesForProjection(
      new Set(['live-server.read']),
      // A config that WOULD retire ids, had the read succeeded: every stored id
      // above belongs to a server absent from this set.
      new Set(['live-server'])
    );

    expect(saveToolPreferencesMock).not.toHaveBeenCalled();
    expect(projection).toMatchObject({ kind: 'unreadable', status: 'unavailable' });
  });
});
