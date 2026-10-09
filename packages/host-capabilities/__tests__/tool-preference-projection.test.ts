import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadToolPreferencesMock, saveToolPreferencesMock } = vi.hoisted(() => ({
  loadToolPreferencesMock: vi.fn(),
  saveToolPreferencesMock: vi.fn(),
}));

vi.mock('@brainstrike/agent', () => ({
  __esModule: true,
  loadToolPreferences: loadToolPreferencesMock,
  saveToolPreferences: saveToolPreferencesMock,
}));

vi.mock('@brainstrike/agent/mcp-client', () => ({
  __esModule: true,
  mcpToolRegistry: { getAllTools: vi.fn(() => ({})) },
}));

import { loadToolPreferencesForProjection } from '../src/mcp/tool-discovery.js';

const USER_DATA = 'mock-user-data';

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
      USER_DATA,
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
      USER_DATA,
      new Set(['live-server.read']),
      // A config that WOULD retire ids, had the read succeeded: every stored id
      // above belongs to a server absent from this set.
      new Set(['live-server'])
    );

    expect(saveToolPreferencesMock).not.toHaveBeenCalled();
    expect(projection).toMatchObject({ kind: 'unreadable', status: 'unavailable' });
  });

  /**
   * The retained-on-disk set must be a superset of the set applied to the
   * registry. Anything else lets one pass hand a preference to the registry and
   * erase it from the file in the same breath -- and `ToolRegistry.register`
   * brings it back enabled next run, the exact failure this file exists to
   * prevent.
   *
   * The two sets were computed from independent predicates: applied by registry
   * membership, retained by a `${name}.` prefix test against the config. Those
   * agree only while tool ids are byte-identical to `config.servers[].name` plus
   * a dot. Any id-composition change, name normalisation, or non-MCP id landing
   * in this file breaks the coupling silently, in a destructive write path.
   */
  it('never retires an id that is live in the registry this run', async () => {
    storedPreferences({ disabledTools: ['weird_id_no_prefix'], enabledTools: [] });

    const projection = await loadToolPreferencesForProjection(
      USER_DATA,
      new Set(['weird_id_no_prefix']),
      new Set(['live-server'])
    );

    // Applied to the registry...
    expect(projection).toEqual({
      disabledTools: ['weird_id_no_prefix'],
      enabledTools: [],
      status: 'available',
    });
    // ...so it must not have been erased from the file in the same pass.
    expect(saveToolPreferencesMock).not.toHaveBeenCalled();
  });

  /**
   * Tool ids are `${server.name}.${tool.name}` and BOTH halves may contain dots,
   * so ownership is not decidable from the id alone: `foo.bar.write` is either
   * server `foo` tool `bar.write` or server `foo.bar` tool `write`.
   *
   * When more than one configured server could own an id, we retain. Retiring on
   * an ownership we cannot establish is the data loss this whole change exists
   * to prevent, and over-retaining costs a few stale strings. Pinned here so the
   * conservative direction cannot be flipped to deletion without a failing test.
   */
  it('retains an id whose owning server cannot be resolved', async () => {
    storedPreferences({ disabledTools: ['foo.bar.write'], enabledTools: [] });

    // `foo.bar` was removed; `foo` remains. `foo.bar.write` could belong to
    // either, so it survives.
    await loadToolPreferencesForProjection(
      USER_DATA,
      new Set(['foo.read']),
      new Set(['foo', 'foo.baz'])
    );

    expect(saveToolPreferencesMock).not.toHaveBeenCalled();
  });

  it('retires an id no configured server could own', async () => {
    storedPreferences({ disabledTools: ['foo.tool'], enabledTools: [] });

    // Server `foo` is gone. `foo.bar` is configured but is not a prefix of
    // `foo.tool`, so nothing configured can claim it.
    await loadToolPreferencesForProjection(USER_DATA, new Set(['foo.bar.w']), new Set(['foo.bar']));

    expect(saveToolPreferencesMock).toHaveBeenCalledWith(
      'mock-user-data',
      expect.objectContaining({ disabledTools: [], enabledTools: [] })
    );
  });
});
