import type {
  RuntimeAssistantMemoryRetrievalMode,
  RuntimeAssistantMemoryScope,
  RuntimeAssistantMemorySettings,
} from '@brainstrike/assistant-contract/memory-settings';
import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import { createBrowserJsonStorage } from '@brainstrike/storage';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';

export const ASSISTANT_MEMORY_PREFERENCES_STORE_NAME = 'assistant-memory-preferences.v1' as const;

const STORE_VERSION = 2;
const MIN_TOKEN_THRESHOLD = 1000;
const MAX_SEMANTIC_TOP_K = 50;
const MAX_MESSAGE_RANGE = 20;

// Remap `provider/model` memory targets that were dropped in the 2026 frontier
// refresh so observational memory never runs against a removed model ID.
// Mirrors MODEL_ID_MIGRATIONS in assistant-preferences-store.ts, with one
// intentional divergence: the dropped chat-latest model maps to the cheaper
// `openai/gpt-5.4-mini` here (background observation is cost-sensitive) rather
// than the primary chat default `gpt-5.4`.
const MEMORY_MODEL_TARGET_MIGRATIONS: Record<string, string> = {
  'anthropic/claude-opus-4-5': 'anthropic/claude-opus-4-8',
  'anthropic/claude-sonnet-4-5': 'anthropic/claude-sonnet-4-6',
  'google/gemini-3-flash-preview': 'google/gemini-3.5-flash',
  'google/gemini-3-pro-preview': 'google/gemini-3.1-pro-preview',
  'openai/gpt-5.2-chat-latest': 'openai/gpt-5.4-mini',
  'openrouter/anthropic/claude-sonnet-4.5': 'openrouter/anthropic/claude-sonnet-4.6',
  'openrouter/google/gemini-3-flash-preview': 'openrouter/google/gemini-3.5-flash',
};

function migrateMemoryModelTarget(target: string): string {
  return MEMORY_MODEL_TARGET_MIGRATIONS[target] ?? target;
}

interface AssistantMemoryPreferencesActions {
  getRuntimeMemorySettings: () => RuntimeAssistantMemorySettings;
  setObservationalMemoryEnabled: (enabled: boolean) => void;
  setObservationalMemoryModelTarget: (modelTarget: string) => void;
  setObservationalMemoryScope: (scope: RuntimeAssistantMemoryScope) => void;
  setObservationalRetrievalMode: (mode: RuntimeAssistantMemoryRetrievalMode) => void;
  setObservationMessageTokens: (value: number) => void;
  setReflectionObservationTokens: (value: number) => void;
  setSemanticRecallEmbeddingModelTarget: (modelTarget: string | null) => void;
  setSemanticRecallEnabled: (enabled: boolean) => void;
  setSemanticRecallMessageRange: (value: number) => void;
  setSemanticRecallScope: (scope: RuntimeAssistantMemoryScope) => void;
  setSemanticRecallTopK: (value: number) => void;
}

interface AssistantMemoryPreferencesData extends RuntimeAssistantMemorySettings {
  hasHydrated: boolean;
}

export type AssistantMemoryPreferencesStore = AssistantMemoryPreferencesData &
  AssistantMemoryPreferencesActions;

interface ElectronStorageBridge {
  readonly getItem: (key: string) => Promise<string | null>;
  readonly removeItem: (key: string) => Promise<void>;
  readonly setItem: (key: string, value: string) => Promise<void>;
}

function getElectronStorageBridge(): ElectronStorageBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }

  return (
    (
      window as Window & {
        electronAPI?: {
          storage?: ElectronStorageBridge;
        };
      }
    ).electronAPI?.storage ?? null
  );
}

function createAssistantMemoryPreferencesStorage() {
  const electronStorage = getElectronStorageBridge();
  if (electronStorage) {
    return {
      getItem: (key: string) => electronStorage.getItem(key),
      removeItem: (key: string) => electronStorage.removeItem(key),
      setItem: (key: string, value: string) => electronStorage.setItem(key, value),
    };
  }

  return createBrowserJsonStorage();
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clampTokenThreshold(value: number): number {
  return clampInteger(value, MIN_TOKEN_THRESHOLD, Number.MAX_SAFE_INTEGER);
}

function normalizeScope(value: unknown): RuntimeAssistantMemoryScope {
  return value === 'resource' ? 'resource' : 'thread';
}

function normalizeRetrievalMode(value: unknown): RuntimeAssistantMemoryRetrievalMode {
  if (value === 'messages' || value === 'vector') {
    return value;
  }
  return 'off';
}

function normalizeMemorySettings(
  settings: Partial<RuntimeAssistantMemorySettings> | undefined
): RuntimeAssistantMemorySettings {
  const defaults = DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS;
  const observational = settings?.observationalMemory;
  const semantic = settings?.semanticRecall;

  return {
    observationalMemory: {
      enabled: observational?.enabled ?? defaults.observationalMemory.enabled,
      messageTokens: clampTokenThreshold(
        observational?.messageTokens ?? defaults.observationalMemory.messageTokens
      ),
      modelTarget: migrateMemoryModelTarget(
        observational?.modelTarget?.trim() || defaults.observationalMemory.modelTarget
      ),
      observationTokens: clampTokenThreshold(
        observational?.observationTokens ?? defaults.observationalMemory.observationTokens
      ),
      retrievalMode: normalizeRetrievalMode(
        observational?.retrievalMode ?? defaults.observationalMemory.retrievalMode
      ),
      scope: normalizeScope(observational?.scope ?? defaults.observationalMemory.scope),
    },
    semanticRecall: {
      embeddingModelTarget:
        semantic?.embeddingModelTarget?.trim() || defaults.semanticRecall.embeddingModelTarget,
      enabled: semantic?.enabled ?? defaults.semanticRecall.enabled,
      messageRange: clampInteger(
        semantic?.messageRange ?? defaults.semanticRecall.messageRange,
        0,
        MAX_MESSAGE_RANGE
      ),
      scope: normalizeScope(semantic?.scope ?? defaults.semanticRecall.scope),
      topK: clampInteger(semantic?.topK ?? defaults.semanticRecall.topK, 1, MAX_SEMANTIC_TOP_K),
    },
  };
}

const initialMemorySettings = normalizeMemorySettings(DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS);

const storage = createJSONStorage(() => createAssistantMemoryPreferencesStorage());

export const useAssistantMemoryPreferencesStore = create<AssistantMemoryPreferencesStore>()(
  persist(
    (set, get) => ({
      hasHydrated: false,
      ...initialMemorySettings,
      getRuntimeMemorySettings: () =>
        normalizeMemorySettings({
          observationalMemory: get().observationalMemory,
          semanticRecall: get().semanticRecall,
        }),
      setObservationalMemoryEnabled: (enabled: boolean) =>
        set((state) => ({
          observationalMemory: { ...state.observationalMemory, enabled },
        })),
      setObservationalMemoryModelTarget: (modelTarget: string) =>
        set((state) => ({
          observationalMemory: {
            ...state.observationalMemory,
            modelTarget: modelTarget.trim(),
          },
        })),
      setObservationalMemoryScope: (scope: RuntimeAssistantMemoryScope) =>
        set((state) => ({
          observationalMemory: { ...state.observationalMemory, scope },
        })),
      setObservationalRetrievalMode: (retrievalMode: RuntimeAssistantMemoryRetrievalMode) =>
        set((state) => ({
          observationalMemory: {
            ...state.observationalMemory,
            retrievalMode: normalizeRetrievalMode(retrievalMode),
          },
        })),
      setObservationMessageTokens: (value: number) =>
        set((state) => ({
          observationalMemory: {
            ...state.observationalMemory,
            messageTokens: clampTokenThreshold(value),
          },
        })),
      setReflectionObservationTokens: (value: number) =>
        set((state) => ({
          observationalMemory: {
            ...state.observationalMemory,
            observationTokens: clampTokenThreshold(value),
          },
        })),
      setSemanticRecallEmbeddingModelTarget: (embeddingModelTarget: string | null) =>
        set((state) => ({
          semanticRecall: {
            ...state.semanticRecall,
            embeddingModelTarget: embeddingModelTarget?.trim() || null,
          },
        })),
      setSemanticRecallEnabled: (enabled: boolean) =>
        set((state) => ({
          semanticRecall: { ...state.semanticRecall, enabled },
        })),
      setSemanticRecallMessageRange: (value: number) =>
        set((state) => ({
          semanticRecall: {
            ...state.semanticRecall,
            messageRange: clampInteger(value, 0, MAX_MESSAGE_RANGE),
          },
        })),
      setSemanticRecallScope: (scope: RuntimeAssistantMemoryScope) =>
        set((state) => ({
          semanticRecall: { ...state.semanticRecall, scope },
        })),
      setSemanticRecallTopK: (value: number) =>
        set((state) => ({
          semanticRecall: {
            ...state.semanticRecall,
            topK: clampInteger(value, 1, MAX_SEMANTIC_TOP_K),
          },
        })),
    }),
    {
      migrate: (persistedState) => {
        if (!persistedState || typeof persistedState !== 'object') {
          return initialMemorySettings;
        }
        return normalizeMemorySettings(persistedState as Partial<RuntimeAssistantMemorySettings>);
      },
      name: ASSISTANT_MEMORY_PREFERENCES_STORE_NAME,
      onRehydrateStorage: () => (state, error) => {
        if (error) {
          return;
        }
        // Defensively remap a dropped observational-memory target on EVERY
        // hydration, not just version bumps. zustand persist only calls
        // `migrate` when persistedVersion < STORE_VERSION, so a stale target
        // persisted at the current version (or a future dropped ID added to
        // MEMORY_MODEL_TARGET_MIGRATIONS without a version bump) would otherwise
        // linger in the persisted state and the settings UI. Mirrors the
        // read-time normalize in getRuntimeMemorySettings.
        if (state) {
          const remapped = migrateMemoryModelTarget(state.observationalMemory.modelTarget);
          if (remapped !== state.observationalMemory.modelTarget) {
            useAssistantMemoryPreferencesStore.setState({
              hasHydrated: true,
              observationalMemory: { ...state.observationalMemory, modelTarget: remapped },
            });
            return;
          }
        }
        useAssistantMemoryPreferencesStore.setState({ hasHydrated: true });
      },
      partialize: (state) => ({
        observationalMemory: state.observationalMemory,
        semanticRecall: state.semanticRecall,
      }),
      storage,
      version: STORE_VERSION,
    }
  )
);

export function __resetAssistantMemoryPreferencesStoreForTests(): void {
  try {
    useAssistantMemoryPreferencesStore.setState({
      hasHydrated: false,
      ...initialMemorySettings,
    });
    const persistApi = (
      useAssistantMemoryPreferencesStore as typeof useAssistantMemoryPreferencesStore & {
        persist?: { clearStorage?: () => void };
      }
    ).persist;
    persistApi?.clearStorage?.();
  } catch {
    // Tests still get the in-memory state reset even when browser storage is unavailable.
  }
}
