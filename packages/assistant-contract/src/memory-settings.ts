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

/**
 * The working-memory scratchpad Brainstrike hands the model.
 *
 * `template` is NOT optional in practice. Omitting it does not mean "no
 * template" — `@mastra/memory` substitutes its own
 * `defaultWorkingMemoryTemplate`, a personal-assistant contact card
 * (First Name / Last Name / Location / Occupation / Interests / Goals /
 * Events / Facts / Projects). That shipped verbatim in a coding IDE, and the
 * template is not inert: Mastra's tool instruction tells the model
 * "Do not remove empty sections", so eight empty PII fields rode in the
 * system prompt of every turn, and the model — having no coding-shaped slot
 * to write into — invented its own headings and filled them with a multi-KB
 * architecture dump.
 *
 * The fields below are chosen to be SELF-LIMITING. Each one names something
 * that is small, current, and would genuinely be lost on a context reset.
 * There is deliberately no "Facts" or "Notes" bucket: an open-ended section
 * is what turned the stock template into a transcript.
 *
 * `scope: 'thread'`, NOT `'resource'`. Resource scope persists one
 * conversation's scratchpad into the prompt of EVERY other thread for that
 * user, so bloat accumulates permanently and never decays — a thread that
 * researched an unrelated subsystem keeps billing every later conversation.
 *
 * BE HONEST ABOUT THE TRADE: on a default profile this leaves NO automatic
 * cross-thread memory at all. {@link DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS}
 * ships observational memory with `retrievalMode: 'off'` and `scope: 'thread'`,
 * and semantic recall `enabled: false`, so neither picks up what resource-scoped
 * working memory used to carry. That is a deliberate reduction, not a handoff:
 * the thing being removed was an unbounded, unprompted transcript prepended to
 * every conversation, and the way back is a user turning on semantic recall
 * (which IS resource-scoped) or observational retrieval — mechanisms that fetch
 * on relevance instead of prepending unconditionally.
 *
 * EXISTING DATA IS ORPHANED, NOT MIGRATED. Anything already written under
 * resource scope lives in `mastra_resources."workingMemory"`; thread scope
 * reads and writes thread metadata instead, so those rows simply stop being
 * read. They are not deleted here — dropping user data is not a side effect a
 * default change may have — and factory reset already covers the table.
 */
export const DEFAULT_RUNTIME_ASSISTANT_WORKING_MEMORY = {
  enabled: true,
  scope: 'thread',
  template: `# Session
- **Active task**:
- **Workspace / roots**:

# Decisions
- (settled choices and why)

# Open questions
- (unresolved, needs the user)

# Key paths
- (files central to this task)
`,
} as const;

/**
 * Sentinel observational-memory model target: resolve the observer at request
 * time via {@link resolveAutoObservationalMemoryModelTarget}. Deliberately has
 * no '/' so it can never be mistaken for a concrete provider/model target.
 */
export const OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET = 'auto';

/**
 * Ordered per-provider auto-observer candidates, grounded in Mastra's
 * observational-memory docs: `google/gemini-2.5-flash` is Mastra's default OM
 * model; Haiku, the fast OpenAI mini, Gemini Flash variants, and DeepSeek V4
 * Flash are on their tested list. OpenRouter needs FALLBACKS because its
 * catalog seeds the preferred Gemini targets disabled by default. The built-in
 * local Gemma is intentionally NOT a candidate: its 8K runtime budget cannot
 * observe the 30K message threshold, so auto-resolving to it would configure a
 * structurally broken observer.
 */
const AUTO_OBSERVATIONAL_MEMORY_CANDIDATES_BY_CHAT_PROVIDER: Readonly<
  Record<string, readonly string[]>
> = {
  anthropic: ['anthropic/claude-haiku-4-5'],
  google: ['google/gemini-2.5-flash'],
  openai: ['openai/gpt-5.4-mini'],
  openrouter: [
    'openrouter/google/gemini-2.5-flash',
    'openrouter/google/gemini-3.5-flash-lite',
    'openrouter/deepseek/deepseek-v4-flash',
  ],
};

/**
 * Ordered auto-observer candidates for a chat provider, or an empty list.
 *
 * PRIVACY INVARIANT (review ruling on BST-940): auto only ever selects an
 * observer from the SELECTED CHAT PROVIDER — the party already receiving the
 * conversation — never a different keyed provider. A local/keyless/unsupported
 * chat therefore yields no candidates and observational memory WAITS visibly
 * (surfaced in settings and the context popover); it must never disable thread
 * memory as a whole, and it must never create new data egress or charges the
 * user didn't already opt into by picking their chat provider. Callers with a
 * model-catalog view (the app-shell resolver) pick the FIRST catalog-eligible
 * candidate; callers without one (the desktop server's raw-client intake) use
 * the first candidate and keep loud downstream credential/model errors.
 */
export function listAutoObservationalMemoryCandidates(args: {
  chatProvider: string | null | undefined;
  providersWithKeys: readonly string[];
}): readonly string[] {
  if (!args.chatProvider) {
    return [];
  }
  const candidates = AUTO_OBSERVATIONAL_MEMORY_CANDIDATES_BY_CHAT_PROVIDER[args.chatProvider];
  if (candidates === undefined || !args.providersWithKeys.includes(args.chatProvider)) {
    return [];
  }
  return candidates;
}

/** First auto-observer candidate for the chat provider, or null. */
export function resolveAutoObservationalMemoryModelTarget(args: {
  chatProvider: string | null | undefined;
  providersWithKeys: readonly string[];
}): string | null {
  return listAutoObservationalMemoryCandidates(args)[0] ?? null;
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
