import {
  type ChunkingPresetSelection,
  type ChunkingSettingsField,
  type ChunkingStrategy,
  getChunkingPreset,
  isChunkingStrategy,
  validateChunkingSettings,
  validateChunkOverlap,
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
 * The cross-field half of the invariant. Overlap >= size makes every chunk
 * re-read at least the whole previous chunk, so the splitter cannot advance.
 * Both fields can be individually in range, so only a pair check catches it.
 */
function assertOverlapBelowSize(chunkOverlap: number, chunkSize: number): void {
  if (chunkOverlap >= chunkSize) {
    throw new Error(`Overlap must be smaller than chunk size (${chunkSize}).`);
  }
}

/**
 * Validate hydrated chunk settings and, where impossible, fall back to the
 * preset the snapshot names (or the default preset when it names none or
 * 'custom'). Returns the repaired values plus one record per replaced field so
 * the UI can tell the user what was discarded.
 */
function repairHydratedChunkSettings(state: ImportSettingsStore): {
  repairs: ChunkingSettingsRepair[];
  values: { chunkOverlap: number; chunkSize: number; chunkTokenLimit: number } | null;
} {
  const validation = validateChunkingSettings({
    chunkOverlap: state.chunkOverlap,
    chunkSize: state.chunkSize,
    chunkTokenLimit: state.chunkTokenLimit,
  });
  if (validation.ok) {
    return { repairs: [], values: null };
  }

  const fallback =
    state.chunkingPreset && state.chunkingPreset !== 'custom'
      ? getChunkingPreset(state.chunkingPreset)
      : DEFAULT_CHUNKING_PRESET;
  const repaired = {
    chunkOverlap: fallback.chunkOverlap,
    chunkSize: fallback.chunkSize,
    chunkTokenLimit: fallback.tokenLimit,
  };
  const discarded: Record<ChunkingSettingsField, number> = {
    chunkOverlap: state.chunkOverlap,
    chunkSize: state.chunkSize,
    chunkTokenLimit: state.chunkTokenLimit,
  };

  // One record per DISTINCT field, so a field failing two rules (say, both
  // out-of-range and breaking the pair invariant) is reported once.
  const repairs: ChunkingSettingsRepair[] = [];
  for (const issue of validation.issues) {
    if (repairs.some((repair) => repair.field === issue.field)) {
      continue;
    }
    repairs.push({
      discardedValue: discarded[issue.field],
      field: issue.field,
      message: issue.message,
      repairedTo: repaired[issue.field],
    });
  }

  // A broken pair is only meaningful as a pair: repairing one side alone can
  // leave the other stranded, so report both sides of an overlap/size conflict.
  if (
    validation.issues.some((issue) => issue.code === 'overlap-not-less-than-size') &&
    !repairs.some((repair) => repair.field === 'chunkSize')
  ) {
    repairs.push({
      discardedValue: discarded.chunkSize,
      field: 'chunkSize',
      message: `Chunk size ${discarded.chunkSize} was not larger than overlap ${discarded.chunkOverlap}.`,
      repairedTo: repaired.chunkSize,
    });
  }

  return { repairs, values: repaired };
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
        assertOverlapBelowSize(result.value, useImportSettingsStore.getState().chunkSize);
        set({ chunkingPreset: 'custom', chunkOverlap: result.value });
      },
      setChunkSize: (n) => {
        const result = validateChunkSize(n);
        if (!result.ok) {
          throw new Error(result.issue.message);
        }
        assertOverlapBelowSize(useImportSettingsStore.getState().chunkOverlap, result.value);
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
      migrate: (state, version) => {
        const snapshot = state as Partial<ImportSettingsStore> | undefined;
        if (!snapshot) {
          return snapshot;
        }
        const next = migrateLegacyPresetState(
          snapshot,
          applyBaseMigrationDefaults(snapshot, version),
          version
        );
        return next satisfies Partial<ImportSettingsStore>;
      },
      name: STORE_NAME,
      onRehydrateStorage: () => (state) => {
        if (state && typeof state.tokenTrueSizing === 'boolean') {
          useTokenPreferencesStore.getState().setAccurateCounting(state.tokenTrueSizing);
        }
        if (!state) {
          return;
        }
        // BST-423. Runs on EVERY hydration, not just a version bump: zustand
        // skips `migrate` when the persisted version matches, so a snapshot
        // written before these invariants existed (or hand-edited, or left
        // invalid by a later bounds change) would otherwise sail straight in.
        const { repairs, values } = repairHydratedChunkSettings(state);
        if (values) {
          useImportSettingsStore.setState({ ...values, chunkingSettingsRepairs: repairs });
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
