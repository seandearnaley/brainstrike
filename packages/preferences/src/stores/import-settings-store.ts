import {
  type ChunkingPresetDefinition,
  type ChunkingPresetSelection,
  type ChunkingSettingsField,
  type ChunkingStrategy,
  getChunkingPreset,
  getChunkingPresetDefinitions,
  isChunkingStrategy,
  validateChunkingSettings,
  validateChunkOverlap,
  validateChunkOverlapAgainstSize,
  validateChunkSize,
  validateChunkTokenLimit,
} from '@brainstrike/indexing-contract';
import { createBrowserJsonStorage } from '@brainstrike/storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { clearPersistedStorageForTests } from './persist-api';
import { useTokenPreferencesStore } from './token-preferences-store';

/**
 * BST-423 — a persisted chunking value that could not be re-entered by hand,
 * replaced at hydration time by the preset default.
 *
 * Repairing rather than throwing is deliberate: a user whose stored settings
 * predate these invariants must still be able to OPEN Settings and fix them.
 * Throwing on rehydrate would leave factory reset as the only exit. But the
 * repair is surfaced, because a silent repair is the same silent normalization
 * this ticket exists to remove.
 */
export interface ChunkingSettingsRepair {
  readonly discardedValue: number;
  readonly field: ChunkingSettingsField;
  readonly message: string;
  readonly repairedTo: number;
}

interface ImportSettingsData {
  chunkingPreset: ChunkingPresetSelection;
  /** Non-persisted, one-time notice. See ChunkingSettingsRepair. */
  chunkingSettingsRepairs: readonly ChunkingSettingsRepair[];
  chunkingStrategy: ChunkingStrategy;
  chunkingStrategyExplicit: boolean;
  chunkOverlap: number;
  chunkSize: number;
  chunkTokenLimit: number;
  enableChunking: boolean;
  tokenTrueSizing: boolean;
}

interface ImportSettingsActions {
  dismissChunkingSettingsRepairs: () => void;
  setChunkingPreset: (value: ChunkingPresetSelection) => void;
  setChunkingStrategy: (v: ChunkingStrategy) => void;
  /** @throws if the value is impossible, or if it would make overlap >= size. */
  setChunkOverlap: (n: number) => void;
  /** @throws if the value is impossible, or if it would make overlap >= size. */
  setChunkSize: (n: number) => void;
  /** @throws if the value is impossible. */
  setChunkTokenLimit: (n: number) => void;
  setEnableChunking: (v: boolean) => void;
  setTokenTrueSizing: (v: boolean) => void;
}

export type ImportSettingsStore = ImportSettingsData & ImportSettingsActions;

const STORE_NAME = 'import-settings.v1' as const;
const STORE_VERSION = 7 as const;

/**
 * Storage adapter with fallback to in-memory for SSR/tests
 */
const storage = createJSONStorage(() => createBrowserJsonStorage());

const getAccurateCountingPreference = () => useTokenPreferencesStore.getState().accurateCounting;
const DEFAULT_CHUNKING_PRESET = getChunkingPreset('balanced');

function normalizePersistedNumericSetting(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizePersistedChunkingStrategy(value: unknown): ChunkingStrategy | null {
  return isChunkingStrategy(value) ? value : null;
}

/**
 * The cross-field half of the invariant, delegated to the contract so the store
 * throws the SAME sentence the settings UI renders. `field` is the input the
 * caller is editing, so the message points at the other side of the pair —
 * previously `setChunkSize(64)` with overlap 100 said "Overlap must be smaller
 * than chunk size (64)", naming the wrong field (review follow-up on #2086).
 */
function assertOverlapBelowSize(
  chunkOverlap: number,
  chunkSize: number,
  field: 'chunkOverlap' | 'chunkSize'
): void {
  const result = validateChunkOverlapAgainstSize(chunkOverlap, chunkSize, field);
  if (!result.ok) {
    throw new Error(result.issue.message);
  }
}

/**
 * Resolve the preset a snapshot names, WITHOUT throwing.
 *
 * Review follow-up on #2086: `getChunkingPreset` throws on an unrecognized id,
 * and this value comes straight from untrusted persisted JSON that nothing on
 * the hydration path validates (`migrate` does not even run when the persisted
 * version matches). A hand-edited or forward-level snapshot would therefore
 * throw during hydration — precisely the lockout the repair exists to avoid.
 * Mirrors `normalizePersistedChunkingStrategy`'s tolerance.
 */
function resolvePresetOrDefault(preset: unknown): ChunkingPresetDefinition {
  if (typeof preset !== 'string' || preset === 'custom') {
    return DEFAULT_CHUNKING_PRESET;
  }
  return (
    getChunkingPresetDefinitions().find((candidate) => candidate.id === preset) ??
    DEFAULT_CHUNKING_PRESET
  );
}

/** A chunk field is only judged when it is actually present and numeric. */
function presentNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * Validate persisted chunk settings and replace ONLY the fields that are
 * impossible, falling back to the preset the snapshot names.
 *
 * Review follow-up on #2086: an earlier version replaced all three fields
 * whenever any one failed, so a snapshot of `{777, 33, 999999}` — where only
 * the token cap is invalid — came back as the balanced preset's `256/50/4096`
 * with a notice mentioning only the token cap. Two perfectly good custom values
 * were discarded silently: the same normalization this ticket removes, merely
 * relocated to hydration.
 *
 * The overlap/size pair is the one exception: it is only meaningful together,
 * so a broken pair moves both sides and reports both.
 */
function repairHydratedChunkSettings(state: Partial<ImportSettingsStore>): {
  repairs: ChunkingSettingsRepair[];
  values: { chunkOverlap: number; chunkSize: number; chunkTokenLimit: number } | null;
} {
  const fallback = resolvePresetOrDefault(state.chunkingPreset);
  const present: Record<ChunkingSettingsField, number | undefined> = {
    chunkOverlap: presentNumber(state.chunkOverlap),
    chunkSize: presentNumber(state.chunkSize),
    chunkTokenLimit: presentNumber(state.chunkTokenLimit),
  };
  // An absent field is not a repair — it simply takes its default.
  const current = {
    chunkOverlap: present.chunkOverlap ?? fallback.chunkOverlap,
    chunkSize: present.chunkSize ?? fallback.chunkSize,
    chunkTokenLimit: present.chunkTokenLimit ?? fallback.tokenLimit,
  };

  const validation = validateChunkingSettings(current);
  if (validation.ok) {
    return { repairs: [], values: null };
  }

  const presetValues: Record<ChunkingSettingsField, number> = {
    chunkOverlap: fallback.chunkOverlap,
    chunkSize: fallback.chunkSize,
    chunkTokenLimit: fallback.tokenLimit,
  };
  const failedFields = new Set(validation.issues.map((issue) => issue.field));
  // The pair moves together or not at all.
  if (validation.issues.some((issue) => issue.code === 'overlap-not-less-than-size')) {
    failedFields.add('chunkOverlap');
    failedFields.add('chunkSize');
  }

  // Start from what was persisted; replace ONLY the failing fields.
  const values = { ...current };
  const repairs: ChunkingSettingsRepair[] = [];
  for (const field of ['chunkOverlap', 'chunkSize', 'chunkTokenLimit'] as const) {
    if (!failedFields.has(field)) {
      continue;
    }
    values[field] = presetValues[field];
    repairs.push({
      discardedValue: current[field],
      field,
      message:
        validation.issues.find((issue) => issue.field === field)?.message ??
        `${field} was replaced because the overlap/size pair was invalid.`,
      repairedTo: presetValues[field],
    });
  }

  return { repairs, values };
}

function applyBaseMigrationDefaults(
  snapshot: Partial<ImportSettingsStore>,
  version: number
): Partial<ImportSettingsStore> {
  if (version < 2) {
    return {
      ...snapshot,
      chunkingPreset:
        typeof snapshot.chunkingPreset === 'string'
          ? snapshot.chunkingPreset
          : DEFAULT_CHUNKING_PRESET.id,
      chunkTokenLimit: 4096,
      tokenTrueSizing: true,
    };
  }

  return {
    ...snapshot,
    chunkingPreset:
      typeof snapshot.chunkingPreset === 'string'
        ? snapshot.chunkingPreset
        : DEFAULT_CHUNKING_PRESET.id,
    chunkTokenLimit:
      typeof snapshot.chunkTokenLimit === 'number'
        ? Math.max(512, Math.min(16_384, Math.floor(snapshot.chunkTokenLimit)))
        : 4096,
    tokenTrueSizing:
      typeof snapshot.tokenTrueSizing === 'boolean' ? snapshot.tokenTrueSizing : true,
  };
}

function migrateLegacyPresetState(
  snapshot: Partial<ImportSettingsStore>,
  next: Partial<ImportSettingsStore>,
  version: number
): Partial<ImportSettingsStore> {
  if (version >= 7 || !next.chunkingPreset || next.chunkingPreset === 'custom') {
    return next;
  }

  const preset = getChunkingPreset(next.chunkingPreset);
  const normalizedStrategy =
    normalizePersistedChunkingStrategy(next.chunkingStrategy) ?? preset.strategy;
  const normalizedChunkSize =
    normalizePersistedNumericSetting(next.chunkSize, 1, Number.MAX_SAFE_INTEGER) ??
    preset.chunkSize;
  const normalizedChunkOverlap =
    normalizePersistedNumericSetting(next.chunkOverlap, 0, Number.MAX_SAFE_INTEGER) ??
    preset.chunkOverlap;
  const normalizedChunkTokenLimit =
    normalizePersistedNumericSetting(next.chunkTokenLimit, 512, 16_384) ?? preset.tokenLimit;
  const hadExplicitPreset = typeof snapshot.chunkingPreset === 'string';
  const shouldPromoteLegacySnapshotToCustom =
    !hadExplicitPreset &&
    (normalizedStrategy !== preset.strategy ||
      normalizedChunkSize !== preset.chunkSize ||
      normalizedChunkOverlap !== preset.chunkOverlap ||
      normalizedChunkTokenLimit !== preset.tokenLimit);

  return {
    ...next,
    chunkingPreset: shouldPromoteLegacySnapshotToCustom ? 'custom' : preset.id,
    chunkingStrategy: normalizedStrategy,
    chunkingStrategyExplicit:
      typeof next.chunkingStrategyExplicit === 'boolean'
        ? next.chunkingStrategyExplicit
        : normalizedStrategy !== 'auto',
    chunkOverlap: normalizedChunkOverlap,
    chunkSize: normalizedChunkSize,
    chunkTokenLimit: normalizedChunkTokenLimit,
  };
}

export const useImportSettingsStore = create<ImportSettingsStore>()(
  persist(
    (set) => ({
      chunkingPreset: DEFAULT_CHUNKING_PRESET.id,
      chunkingSettingsRepairs: [],
      chunkingStrategy: DEFAULT_CHUNKING_PRESET.strategy,
      chunkingStrategyExplicit: DEFAULT_CHUNKING_PRESET.strategy !== 'auto',
      chunkOverlap: DEFAULT_CHUNKING_PRESET.chunkOverlap,
      chunkSize: DEFAULT_CHUNKING_PRESET.chunkSize,
      chunkTokenLimit: DEFAULT_CHUNKING_PRESET.tokenLimit,
      dismissChunkingSettingsRepairs: () => set({ chunkingSettingsRepairs: [] }),
      enableChunking: true,
      setChunkingPreset: (value) => {
        if (value === 'custom') {
          set({ chunkingPreset: 'custom' });
          return;
        }
        const preset = getChunkingPreset(value);
        set({
          chunkingPreset: preset.id,
          chunkingStrategy: preset.strategy,
          chunkingStrategyExplicit: preset.strategy !== 'auto',
          chunkOverlap: preset.chunkOverlap,
          chunkSize: preset.chunkSize,
          chunkTokenLimit: preset.tokenLimit,
        });
      },
      setChunkingStrategy: (v) =>
        set({
          chunkingPreset: 'custom',
          chunkingStrategy: v,
          chunkingStrategyExplicit: true,
        }),
      // BST-423. These used to clamp: `Math.max(0, Math.floor(n))` turned a
      // typed -42.7 into 0 and `Math.floor(n) || 512` turned both NaN and a
      // legitimate 0 into 512. An impossible value is now rejected and named,
      // and a rejected write leaves the previous good value untouched.
      //
      // The cross-field rule is checked from BOTH directions: raising overlap
      // above size and lowering size below overlap are the same violation, and
      // neither was guarded.
      setChunkOverlap: (n) => {
        const result = validateChunkOverlap(n);
        if (!result.ok) {
          throw new Error(result.issue.message);
        }
        assertOverlapBelowSize(
          result.value,
          useImportSettingsStore.getState().chunkSize,
          'chunkOverlap'
        );
        set({ chunkingPreset: 'custom', chunkOverlap: result.value });
      },
      setChunkSize: (n) => {
        const result = validateChunkSize(n);
        if (!result.ok) {
          throw new Error(result.issue.message);
        }
        assertOverlapBelowSize(
          useImportSettingsStore.getState().chunkOverlap,
          result.value,
          'chunkSize'
        );
        set({ chunkingPreset: 'custom', chunkSize: result.value });
      },
      setChunkTokenLimit: (n) => {
        const result = validateChunkTokenLimit(n);
        if (!result.ok) {
          throw new Error(result.issue.message);
        }
        set({ chunkingPreset: 'custom', chunkTokenLimit: result.value });
      },

      setEnableChunking: (v) => set({ enableChunking: !!v }),
      setTokenTrueSizing: (v) => {
        const next = !!v;
        useTokenPreferencesStore.getState().setAccurateCounting(next);
        set({ tokenTrueSizing: next });
      },
      tokenTrueSizing: getAccurateCountingPreference(),
    }),
    {
      /**
       * BST-423 repair runs HERE, not in `onRehydrateStorage`.
       *
       * Review follow-up on #2086: `createSafeJsonStateStorage().getItem` is
       * synchronous, so zustand resolves hydration DURING `create(...)` — while
       * the module-level `useImportSettingsStore` binding is still in its
       * temporal dead zone. The old code called `useImportSettingsStore.setState`
       * from the rehydrate callback, which threw a ReferenceError that zustand
       * swallowed: the invalid values stayed live with no repair and no notice.
       * The store's other tests could not see it because they call
       * `persist.rehydrate()` after module load, when the binding exists.
       *
       * `merge` needs no module binding, and runs on every hydration — including
       * the version-matched case where `migrate` never runs.
       */
      merge: (persistedState, currentState) => {
        const merged = {
          ...currentState,
          ...(persistedState as Partial<ImportSettingsStore> | undefined),
        };
        // A repair already recorded by `migrate` (from the raw snapshot) wins:
        // it saw the pre-clamp values, so its record is the truthful one.
        if (merged.chunkingSettingsRepairs && merged.chunkingSettingsRepairs.length > 0) {
          return merged;
        }
        const { repairs, values } = repairHydratedChunkSettings(merged);
        if (!values) {
          return { ...merged, chunkingSettingsRepairs: [] };
        }
        return { ...merged, ...values, chunkingSettingsRepairs: repairs };
      },
      migrate: (state, version) => {
        const snapshot = state as Partial<ImportSettingsStore> | undefined;
        if (!snapshot) {
          return snapshot;
        }
        // Review follow-up on #2086: judge the RAW snapshot FIRST. The legacy
        // normalizers below clamp — `applyBaseMigrationDefaults` bounds the
        // token limit and `normalizePersistedNumericSetting` bounds size and
        // overlap — so a persisted 99999 would reach the validator as a
        // perfectly valid 16384 and report no repair at all. Anyone upgrading
        // from an older version would stay on exactly the silent-normalization
        // path this ticket removes.
        const rawRepair = repairHydratedChunkSettings(snapshot);
        const next = migrateLegacyPresetState(
          snapshot,
          applyBaseMigrationDefaults(snapshot, version),
          version
        );
        if (rawRepair.values) {
          return {
            ...next,
            ...rawRepair.values,
            chunkingSettingsRepairs: rawRepair.repairs,
          } satisfies Partial<ImportSettingsStore>;
        }
        return next satisfies Partial<ImportSettingsStore>;
      },
      name: STORE_NAME,
      // The chunk-settings repair deliberately does NOT live here — see `merge`
      // above. This callback runs while the module binding is still in its TDZ,
      // so anything that reaches for `useImportSettingsStore` throws into
      // zustand's swallow. Keep this to work that only touches `state`.
      onRehydrateStorage: () => (state) => {
        if (state && typeof state.tokenTrueSizing === 'boolean') {
          useTokenPreferencesStore.getState().setAccurateCounting(state.tokenTrueSizing);
        }
      },
      partialize: (s) => ({
        // chunkingSettingsRepairs is deliberately ABSENT: the notice is a
        // one-time in-session signal. Persisting it would make the warning
        // immortal, reappearing every launch long after the fix.
        chunkingPreset: s.chunkingPreset,
        chunkingStrategy: s.chunkingStrategy,
        chunkingStrategyExplicit: s.chunkingStrategyExplicit,
        chunkOverlap: s.chunkOverlap,
        chunkSize: s.chunkSize,
        chunkTokenLimit: s.chunkTokenLimit,
        enableChunking: s.enableChunking,
        tokenTrueSizing: s.tokenTrueSizing,
      }),
      storage,
      version: STORE_VERSION,
    }
  )
);

function bindTokenPreferencesSync(): () => void {
  return useTokenPreferencesStore.subscribe((preferences) => {
    const current = useImportSettingsStore.getState().tokenTrueSizing;
    if (current !== preferences.accurateCounting) {
      useImportSettingsStore.setState({ tokenTrueSizing: preferences.accurateCounting });
    }
  });
}

// Module-scoped subscription is intentional: this store is a singleton in app/runtime code.
// Tests explicitly reset and rebind it to avoid cross-test leakage.
let unsubscribeTokenPreferencesSync = bindTokenPreferencesSync();

export const importSettingsSelectors = {
  chunking: (s: ImportSettingsStore) => [s.enableChunking, s.chunkingStrategy] as const,
  sizes: (s: ImportSettingsStore) => [s.chunkSize, s.chunkOverlap] as const,
  tokenLimit: (s: ImportSettingsStore) => s.chunkTokenLimit,
  tokenSizing: (s: ImportSettingsStore) => s.tokenTrueSizing,
};

// Test-only helper to avoid cross-test persistence
export function __resetImportSettingsStoreForTests() {
  clearPersistedStorageForTests(useImportSettingsStore);
  useTokenPreferencesStore.getState().setAccurateCounting(true);
  useImportSettingsStore.setState({
    chunkingPreset: DEFAULT_CHUNKING_PRESET.id,
    chunkingSettingsRepairs: [],
    chunkingStrategy: DEFAULT_CHUNKING_PRESET.strategy,
    chunkingStrategyExplicit: false,
    chunkOverlap: DEFAULT_CHUNKING_PRESET.chunkOverlap,
    chunkSize: DEFAULT_CHUNKING_PRESET.chunkSize,
    chunkTokenLimit: DEFAULT_CHUNKING_PRESET.tokenLimit,
    enableChunking: true,
    tokenTrueSizing: true,
  });
  unsubscribeTokenPreferencesSync();
  unsubscribeTokenPreferencesSync = bindTokenPreferencesSync();
}
