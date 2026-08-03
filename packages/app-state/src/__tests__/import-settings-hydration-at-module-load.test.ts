import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * BST-423, review follow-up on #2086.
 *
 * The other store tests call `persist.rehydrate()` AFTER module load, when the
 * `useImportSettingsStore` binding already exists. That is not how the app
 * hydrates. `createSafeJsonStateStorage().getItem` is SYNCHRONOUS, so zustand's
 * `persist` resolves hydration during `create(...)` — while the module-level
 * `const useImportSettingsStore = ...` is still in its temporal dead zone.
 *
 * If the rehydrate callback reaches for that binding, it throws a
 * `ReferenceError` which zustand swallows (it re-invokes the callback with
 * `state === undefined`), and the invalid values stay live with no repair and
 * no notice — silent degradation, which is the exact thing this feature exists
 * to remove.
 *
 * This test hydrates the way the app does: seed storage FIRST, then import the
 * module fresh.
 */
describe('import settings hydration at module load', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it('repairs invalid persisted settings during the module-load hydration', async () => {
    localStorage.setItem(
      'import-settings.v1',
      JSON.stringify({
        state: {
          chunkingPreset: 'balanced',
          chunkingStrategy: 'auto',
          chunkingStrategyExplicit: false,
          chunkOverlap: 50,
          // Impossible: below the 128 minimum.
          chunkSize: 4,
          chunkTokenLimit: 4096,
          enableChunking: true,
          tokenTrueSizing: true,
        },
        version: 7,
      })
    );

    const { useImportSettingsStore } = await import('../stores/import-settings-store');
    const state = useImportSettingsStore.getState();

    expect(state.chunkSize).toBe(256);
    expect(state.chunkingSettingsRepairs.map((repair) => repair.field)).toContain('chunkSize');
  });

  it('leaves a valid persisted snapshot untouched at module load', async () => {
    localStorage.setItem(
      'import-settings.v1',
      JSON.stringify({
        state: {
          chunkingPreset: 'custom',
          chunkingStrategy: 'recursive',
          chunkingStrategyExplicit: true,
          chunkOverlap: 33,
          chunkSize: 777,
          chunkTokenLimit: 5555,
          enableChunking: true,
          tokenTrueSizing: true,
        },
        version: 7,
      })
    );

    const { useImportSettingsStore } = await import('../stores/import-settings-store');
    const state = useImportSettingsStore.getState();

    expect(state.chunkSize).toBe(777);
    expect(state.chunkOverlap).toBe(33);
    expect(state.chunkTokenLimit).toBe(5555);
    expect(state.chunkingSettingsRepairs).toEqual([]);
  });

  it('does not throw on an unrecognized persisted preset id', async () => {
    // `getChunkingPreset` THROWS on an unknown id, and this value comes straight
    // from untrusted persisted JSON that nothing on this path validates.
    localStorage.setItem(
      'import-settings.v1',
      JSON.stringify({
        state: {
          chunkingPreset: 'strict-code-v2',
          chunkOverlap: 50,
          chunkSize: 4,
          chunkTokenLimit: 4096,
          enableChunking: true,
          tokenTrueSizing: true,
        },
        version: 7,
      })
    );

    const { useImportSettingsStore } = await import('../stores/import-settings-store');
    const state = useImportSettingsStore.getState();
    // Falls back to the default preset rather than locking the user out.
    expect(state.chunkSize).toBe(256);
    expect(state.chunkingSettingsRepairs.length).toBeGreaterThan(0);
  });

  // Review follow-up on #2086: BOTH reviewers flagged that one bad field used
  // to replace all three. Neither existing test could see it — the repair case
  // invalidated overlap AND size, and its `chunkTokenLimit: 4096` happened to
  // equal the balanced preset's own tokenLimit, so the over-repair was
  // invisible. This is the partial-invalidity case that pins it.
  it('repairs ONLY the invalid field and preserves valid custom values', async () => {
    localStorage.setItem(
      'import-settings.v1',
      JSON.stringify({
        state: {
          chunkingPreset: 'custom',
          chunkingStrategy: 'recursive',
          chunkingStrategyExplicit: true,
          // Both valid, and both deliberately DIFFERENT from the balanced
          // preset's 50/256 so an over-repair cannot hide.
          chunkOverlap: 33,
          chunkSize: 777,
          // The only impossible value.
          chunkTokenLimit: 999_999,
          enableChunking: true,
          tokenTrueSizing: true,
        },
        version: 7,
      })
    );

    const { useImportSettingsStore } = await import('../stores/import-settings-store');
    const state = useImportSettingsStore.getState();

    expect(state.chunkSize).toBe(777);
    expect(state.chunkOverlap).toBe(33);
    expect(state.chunkTokenLimit).toBe(4096);
    expect(state.chunkingSettingsRepairs.map((repair) => repair.field)).toEqual([
      'chunkTokenLimit',
    ]);
  });

  // The overlap/size pair is the one legitimate exception: it only means
  // anything together, so a broken pair moves both sides AND reports both.
  it('moves and reports both sides of a broken overlap/size pair', async () => {
    localStorage.setItem(
      'import-settings.v1',
      JSON.stringify({
        state: {
          chunkingPreset: 'balanced',
          chunkOverlap: 200,
          chunkSize: 150,
          chunkTokenLimit: 8192,
          enableChunking: true,
          tokenTrueSizing: true,
        },
        version: 7,
      })
    );

    const { useImportSettingsStore } = await import('../stores/import-settings-store');
    const state = useImportSettingsStore.getState();

    expect(state.chunkOverlap).toBe(50);
    expect(state.chunkSize).toBe(256);
    // The valid token cap is untouched.
    expect(state.chunkTokenLimit).toBe(8192);
    expect(state.chunkingSettingsRepairs.map((repair) => repair.field).sort()).toEqual([
      'chunkOverlap',
      'chunkSize',
    ]);
  });

  // Review follow-up on #2086: for versions below 7 zustand runs `migrate`
  // BEFORE hydration finishes, and those legacy normalizers CLAMP — a stored
  // 99999 would arrive at the validator as a perfectly valid 16384 and report
  // no repair, leaving old-version upgraders on the silent path.
  it('reports a repair for a legacy snapshot the migration would have clamped', async () => {
    localStorage.setItem(
      'import-settings.v1',
      JSON.stringify({
        state: {
          chunkingPreset: 'balanced',
          chunkOverlap: 50,
          chunkSize: 256,
          chunkTokenLimit: 999_999,
          enableChunking: true,
          tokenTrueSizing: true,
        },
        version: 6,
      })
    );

    const { useImportSettingsStore } = await import('../stores/import-settings-store');
    const state = useImportSettingsStore.getState();

    expect(state.chunkingSettingsRepairs.map((repair) => repair.field)).toContain(
      'chunkTokenLimit'
    );
    // The notice names what was actually stored, not the clamped value.
    const repair = state.chunkingSettingsRepairs.find((entry) => entry.field === 'chunkTokenLimit');
    expect(repair?.discardedValue).toBe(999_999);
  });
});
