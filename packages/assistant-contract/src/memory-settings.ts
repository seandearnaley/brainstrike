export type RuntimeAssistantMemoryScope = 'resource' | 'thread';

export type RuntimeAssistantMemoryRetrievalMode = 'off' | 'messages' | 'vector';

export interface RuntimeAssistantObservationalMemorySettings {
  enabled: boolean;
  messageTokens: number;
  modelTarget: string;
  observationTokens: number;
  retrievalMode: RuntimeAssistantMemoryRetrievalMode;
  scope: RuntimeAssistantMemoryScope;
}

export interface RuntimeAssistantSemanticRecallSettings {
  embeddingModelTarget: string | null;
  enabled: boolean;
  messageRange: number;
  scope: RuntimeAssistantMemoryScope;
  topK: number;
}

export interface RuntimeAssistantMemorySettings {
  observationalMemory: RuntimeAssistantObservationalMemorySettings;
  semanticRecall: RuntimeAssistantSemanticRecallSettings;
}

export const DEFAULT_RUNTIME_ASSISTANT_LAST_MESSAGES = 40;

export const DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY = {
  enabled: true,
  scope: 'resource',
} as const;

/**
 * Sentinel observational-memory model target: resolve the observer at request
 * time via {@link resolveAutoObservationalMemoryModelTarget}. Deliberately has
 * no '/' so it can never be mistaken for a concrete provider/model target.
 */
export const OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET = 'auto';

/**
 * Ordered auto-observer candidates, grounded in Mastra's observational-memory
 * docs: `google/gemini-2.5-flash` is Mastra's default OM model; Haiku and the
 * fast OpenAI mini are on their tested list; the OpenRouter entry routes to the
 * same Mastra default through the gateway. The built-in local Gemma is
 * intentionally NOT a candidate: its 8K runtime budget cannot observe the 30K
 * message threshold, so auto-resolving to it would configure a structurally
 * broken observer.
 */
const AUTO_OBSERVATIONAL_MEMORY_CANDIDATES: readonly {
  readonly provider: string;
  readonly target: string;
}[] = [
  { provider: 'google', target: 'google/gemini-2.5-flash' },
  { provider: 'anthropic', target: 'anthropic/claude-haiku-4-5' },
  { provider: 'openai', target: 'openai/gpt-5.4-mini' },
  { provider: 'openrouter', target: 'openrouter/google/gemini-2.5-flash' },
];

/**
 * Resolve the 'auto' observer target to a concrete provider/model the profile
 * can run, or null when no keyed provider is eligible. Pure and deterministic:
 * candidate order decides, never key-source order. A null resolution means
 * observational memory WAITS visibly (surfaced in settings and the context
 * popover) — it must never disable thread memory as a whole.
 */
export function resolveAutoObservationalMemoryModelTarget(args: {
  providersWithKeys: readonly string[];
}): string | null {
  const keyed = new Set(args.providersWithKeys);
  for (const candidate of AUTO_OBSERVATIONAL_MEMORY_CANDIDATES) {
    if (keyed.has(candidate.provider)) {
      return candidate.target;
    }
  }
  return null;
}

/**
 * Construction-safe memory settings for runtime seams that receive NO resolved
 * settings (memory factory default arg, desktop-server absent-field fallbacks).
 * The UI-facing DEFAULT below turns observations on with the 'auto' sentinel,
 * which only the app-shell resolver can interpret — a construction seam must
 * never manufacture an enabled observer out of an absent settings object.
 */
export const CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS: RuntimeAssistantMemorySettings = {
  observationalMemory: {
    enabled: false,
    messageTokens: 30_000,
    modelTarget: OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET,
    observationTokens: 40_000,
    retrievalMode: 'off',
    scope: 'thread',
  },
  semanticRecall: {
    embeddingModelTarget: 'openai/text-embedding-3-small',
    enabled: false,
    messageRange: 2,
    scope: 'resource',
    topK: 5,
  },
};

export const DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS: RuntimeAssistantMemorySettings = {
  observationalMemory: {
    // ON by default (BST-940) at Mastra's documented thresholds (observation
    // 30K / reflection 40K). The 'auto' target resolves at request time to a
    // Mastra-recommended fast observer the profile can actually run, so a
    // fresh local-only profile never acquires an undeclared hosted API-key
    // requirement: with no eligible key the observer stays visibly unresolved
    // and thread memory keeps working.
    enabled: true,
    messageTokens: 30_000,
    modelTarget: OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET,
    observationTokens: 40_000,
    retrievalMode: 'off',
    scope: 'thread',
  },
  semanticRecall: {
    embeddingModelTarget: 'openai/text-embedding-3-small',
    enabled: false,
    messageRange: 2,
    scope: 'resource',
    topK: 5,
  },
};
