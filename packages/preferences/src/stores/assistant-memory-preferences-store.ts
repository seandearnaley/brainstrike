import type {
  RuntimeAssistantMemoryRetrievalMode,
  RuntimeAssistantMemoryScope,
  RuntimeAssistantMemorySettings,
} from '@brainstrike/assistant-contract/memory-settings';
import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import { createJSONStorage, persist } from 'zustand/middleware';
import { createWithEqualityFn as create } from 'zustand/traditional';
import { createBrowserJsonStorage } from './browser-json-storage';

export const ASSISTANT_MEMORY_PREFERENCES_STORE_NAME = 'assistant-memory-preferences.v1' as const;

const STORE_VERSION = 2;
const MIN_TOKEN_THRESHOLD = 1000;
const MAX_SEMANTIC_TOP_K = 50;
const MAX_MESSAGE_RANGE = 20;

// Remap `provider/model` memory targets that were dropped in the 2026 frontier
// refresh so observational memory never runs against a removed model ID. Kept
// in sync with MODEL_ID_MIGRATIONS in assistant-preferences-store.ts.
const MEMORY_MODEL_TARGET_MIGRATIONS: Record<string, string> = {
  'openai/gpt-5.2-chat-latest': 'openai/gpt-5.4-mini',
  'anthropic/claude-sonnet-4-5': 'anthropic/claude-sonnet-4-6',
  'anthropic/claude-opus-4-5': 'anthropic/claude-opus-4-8',
  'google/gemini-3-flash-preview': 'google/gemini-3.5-flash',
  'google/gemini-3-pro-preview': 'google/gemini-3.1-pro-preview',
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
      modelTarget: migrateMemoryModelTarget(
        observational?.modelTarget?.trim() || defaults.observationalMemory.modelTarget
      ),
      scope: normalizeScope(observational?.scope ?? defaults.observationalMemory.scope),
      messageTokens: clampTokenThreshold(
        observational?.messageTokens ?? defaults.observationalMemory.messageTokens
      ),
      observationTokens: clampTokenThreshold(
        observational?.observationTokens ?? defaults.observationalMemory.observationTokens
      ),
      retrievalMode: normalizeRetrievalMode(
        observational?.retrievalMode ?? defaults.observationalMemory.retrievalMode
      ),
    },
    semanticRecall: {
      enabled: semantic?.enabled ?? defaults.semanticRecall.enabled,
      embeddingModelTarget:
        semantic?.embeddingModelTarget?.trim() || defaults.semanticRecall.embeddingModelTarget,
      scope: normalizeScope(semantic?.scope ?? defaults.semanticRecall.scope),
      topK: clampInteger(semantic?.topK ?? defaults.semanticRecall.topK, 1, MAX_SEMANTIC_TOP_K),
      messageRange: clampInteger(
        semantic?.messageRange ?? defaults.semanticRecall.messageRange,
        0,
        MAX_MESSAGE_RANGE
      ),
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
      setObservationalRetrievalMode: (retrievalMode: RuntimeAssistantMemoryRetrievalMode) =>
        set((state) => ({
          observationalMemory: {
            ...state.observationalMemory,
            retrievalMode: normalizeRetrievalMode(retrievalMode),
          },
        })),
      setSemanticRecallEnabled: (enabled: boolean) =>
        set((state) => ({
          semanticRecall: { ...state.semanticRecall, enabled },
        })),
      setSemanticRecallEmbeddingModelTarget: (embeddingModelTarget: string | null) =>
        set((state) => ({
          semanticRecall: {
            ...state.semanticRecall,
            embeddingModelTarget: embeddingModelTarget?.trim() || null,
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
      setSemanticRecallMessageRange: (value: number) =>
        set((state) => ({
          semanticRecall: {
            ...state.semanticRecall,
            messageRange: clampInteger(value, 0, MAX_MESSAGE_RANGE),
          },
        })),
    }),
    {
      name: ASSISTANT_MEMORY_PREFERENCES_STORE_NAME,
      version: STORE_VERSION,
      storage,
      partialize: (state) => ({
        observationalMemory: state.observationalMemory,
        semanticRecall: state.semanticRecall,
      }),
      migrate: (persistedState) => {
        if (!persistedState || typeof persistedState !== 'object') {
          return initialMemorySettings;
        }
        return normalizeMemorySettings(persistedState as Partial<RuntimeAssistantMemorySettings>);
      },
      onRehydrateStorage: () => (_state, error) => {
        if (!error) {
          useAssistantMemoryPreferencesStore.setState({ hasHydrated: true });
        }
      },
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
