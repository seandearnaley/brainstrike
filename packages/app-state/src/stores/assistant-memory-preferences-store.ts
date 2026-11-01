import type {
  RuntimeAssistantMemoryRetrievalMode,
  RuntimeAssistantMemoryScope,
  RuntimeAssistantMemorySettings,
} from '@brainstrike/assistant-contract/memory-settings';
import { DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS } from '@brainstrike/assistant-contract/memory-settings';
import { persistDurable } from '@brainstrike/storage';
import { createWithEqualityFn as create } from 'zustand/traditional';

export const ASSISTANT_MEMORY_PREFERENCES_STORE_NAME =
  'brainstrike:assistant-memory-preferences.v1' as const;

const STORE_VERSION = 2;
/**
 * The whole-number ranges the memory settings accept. Settings validates input
 * against them visibly; the store normalizes persisted values into them.
 */
export const ASSISTANT_MEMORY_NUMBER_LIMITS = {
  tokenThreshold: { max: Number.MAX_SAFE_INTEGER, min: 1000 },
} as const;
const MIN_TOKEN_THRESHOLD = ASSISTANT_MEMORY_NUMBER_LIMITS.tokenThreshold.min;

// Remap `provider/model` memory targets that were dropped in the 2026 frontier
// refresh so observational memory never runs against a removed model ID.
// Mirrors MODEL_ID_MIGRATIONS in assistant-model-id-migrations.ts, with one
// intentional divergence: the dropped chat-latest model maps to the cheaper
// `openai/gpt-5.4-mini` here (background observation is cost-sensitive) rather
// than the primary chat default `gpt-5.4`.
const MEMORY_MODEL_TARGET_MIGRATIONS: Record<string, string> = {
  'anthropic/claude-opus-4-5': 'anthropic/claude-opus-4-8',
  'anthropic/claude-sonnet-4-5': 'anthropic/claude-sonnet-4-6',
  'google/gemini-3-flash-preview': 'google/gemini-3.8-flash',
  'google/gemini-3-pro-preview': 'google/gemini-3.1-pro-preview',
  'google/gemini-3.5-flash': 'google/gemini-3.8-flash',
  'google/gemini-3.7-flash': 'google/gemini-3.8-flash',
  'openai/gpt-5.2-chat-latest': 'openai/gpt-5.4-mini',
  'openrouter/anthropic/claude-sonnet-4.5': 'openrouter/anthropic/claude-sonnet-4.6',
  'openrouter/google/gemini-3-flash-preview': 'openrouter/google/gemini-3.5-flash',
  // BST-1697 delistings. Keys are provider-prefixed composite targets, so the
  // OpenRouter route id carries its own vendor segment as well.
  'openrouter/inclusionai/ling-3.0-flash:free': 'openrouter/inclusionai/ling-3.0-flash',
  'openrouter/kwaipilot/kat-coder-air-v2.5': 'openrouter/kwaipilot/kat-coder-pro-v2.5',
  'openrouter/qwen/qwen3.8-max': 'openrouter/qwen/qwen3.8-max-0902',
  'openrouter/stealth/ox-alpha': 'openrouter/qwen/qwen3.8-flash',
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
}

interface AssistantMemoryPreferencesData extends RuntimeAssistantMemorySettings {
  hasHydrated: boolean;
}

export type AssistantMemoryPreferencesStore = AssistantMemoryPreferencesData &
  AssistantMemoryPreferencesActions;

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
  return value === 'messages' ? 'messages' : 'off';
}

function normalizeMemorySettings(
  settings: Partial<RuntimeAssistantMemorySettings> | undefined
): RuntimeAssistantMemorySettings {
  const defaults = DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS;
  const observational = settings?.observationalMemory;

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
  };
}

const initialMemorySettings = normalizeMemorySettings(DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS);

export const useAssistantMemoryPreferencesStore = create<AssistantMemoryPreferencesStore>()(
  persistDurable(
    ASSISTANT_MEMORY_PREFERENCES_STORE_NAME,
    (set, get) => ({
      hasHydrated: false,
      ...initialMemorySettings,
      getRuntimeMemorySettings: () =>
        normalizeMemorySettings({ observationalMemory: get().observationalMemory }),
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
    }),
    {
      /**
       * BST-1645: the normalize + `hasHydrated` mark run HERE, not in
       * `onRehydrateStorage`.
       *
       * `localStorage` is synchronous, so zustand's
       * persist middleware resolves hydration DURING `create(...)` — while the
       * module-level `useAssistantMemoryPreferencesStore` binding is still in
       * its temporal dead zone. The old rehydrate callback called
       * `useAssistantMemoryPreferencesStore.setState` and threw a
       * ReferenceError that zustand swallowed (it re-invokes the callback as
       * `(undefined, error)`, whose `if (error) return` guard then declines),
       * so on the app's real hydration path neither the remap nor
       * `hasHydrated` ever landed. Same bug as #2086; see
       * `token-preferences-store.ts`.
       *
       * `merge` needs no module binding and runs on EVERY hydration, not just
       * version bumps: zustand only calls `migrate` when
       * `persistedVersion !== STORE_VERSION`, so a target dropped without a
       * version bump would otherwise linger in the persisted state and the
       * settings UI. Mirrors the read-time normalize in
       * `getRuntimeMemorySettings`.
       */
      merge: (persistedState, currentState) => {
        // No snapshot (first run): keep the current state; only mark hydration complete.
        if (persistedState === undefined || persistedState === null) {
          return { ...currentState, hasHydrated: true };
        }
        return {
          ...currentState,
          ...normalizeMemorySettings(
            typeof persistedState === 'object'
              ? (persistedState as Partial<RuntimeAssistantMemorySettings>)
              : undefined
          ),
          hasHydrated: true,
        };
      },
      migrate: (persistedState) => {
        if (!persistedState || typeof persistedState !== 'object') {
          return initialMemorySettings;
        }
        return normalizeMemorySettings(persistedState as Partial<RuntimeAssistantMemorySettings>);
      },
      partialize: (state) => ({ observationalMemory: state.observationalMemory }),
      version: STORE_VERSION,
    }
  )
);
