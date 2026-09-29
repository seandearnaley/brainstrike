/**
 * Cross-cutting type definitions for assistant provider settings.
 *
 * These types are intentionally hosted in `@brainstrike/types` (a leaf
 * package with no runtime deps) so both `@brainstrike/ui` and
 * `@brainstrike/app-state` can share a single canonical definition.
 *
 * Previously the same shapes were duplicated in
 * `packages/assistant-ui/src/assistant-ui-panel.tsx` and
 * `packages/app-state/src/stores/assistant-preferences-store.ts` because
 * `preferences` depends on `ui` (forbidding the reverse import). Reviewers
 * flagged this duplication five times on PR #873; centralising here is the
 * structural fix.
 *
 * Intentional non-goals:
 *   - We do NOT depend on `@brainstrike/agent` here (would create a cycle
 *     for the agent package itself if it ever needed these types). The
 *     provider-id keyed map (`Record<SupportedProvider, ...>`) is therefore
 *     still defined locally in `assistant-preferences-store.ts` where the
 *     `SupportedProvider` brand is available.
 */

/**
 * THE reasoning-effort vocabulary, weakest to strongest.
 *
 * Mirrors the `reasoningEffort` enum of the installed `@ai-sdk/openai` (4.0.49)
 * chat-options declaration; policed by
 * `scripts/__tests__/ai-sdk-openai-mirror-contract.test.mjs`.
 *
 * This is the union's MEMBERSHIP, not an offered list. Nothing here says a
 * given model accepts every value: what a particular model offers is resolved
 * per-family by `resolveReasoningControlsAvailability`
 * (`@brainstrike/assistant-contract/model-reasoning`), and narrowing an offered
 * list must never be expressed by narrowing this declaration — see the
 * per-model `anthropicReasoning` ladder ruling in `docs/agents/assistant-providers.md`.
 * Its only job is to be the single place the values are written down.
 *
 * Declared as a value so the one place that needs them at RUNTIME — the Hosted
 * Web request-boundary `z.enum` in
 * `apps/web/src/server/web-assistant-runtime-schema.ts` — derives from the same
 * source as the type it validates. It was previously a fourth hand-copy: a
 * narrower copy rejects an effort the picker offers, a wider one lets a value
 * the provider rejects reach the wire, and both fail at runtime against a green
 * type-check.
 */
export const OPENAI_REASONING_EFFORT_VALUES = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type OpenAiReasoningEffort = (typeof OPENAI_REASONING_EFFORT_VALUES)[number];
export type OpenAiReasoningSummary = 'auto' | 'detailed';
/**
 * Mirrors the `effort` enum of the installed `@ai-sdk/anthropic` (4.0.49).
 * `xhigh`/`max` are real wire values — omitting them made the picker offer a
 * strictly narrower range than the provider accepts.
 *
 * The provider ships this as a zod schema it never exports as a value, so the
 * union is retyped by hand. It is no longer only a comment:
 * `scripts/__tests__/ai-sdk-anthropic-mirror-contract.test.mjs` compares this
 * declaration — and the version named above — against the installed package.
 */
export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/**
 * Mirrors the `reasoningConfig.maxReasoningEffort` enum of the installed
 * `@ai-sdk/amazon-bedrock` (5.0.76). Structurally identical to
 * `AnthropicEffort` today and deliberately declared separately: they mirror
 * two independent upstream packages, so aliasing one to the other would make
 * an upgrade to either silently redefine the other's picker.
 * `bedrock-reasoning-dialect-contract.spec.ts` compares this declaration
 * against the installed provider.
 */
export type BedrockReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type GoogleThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

/** Thinking levels offered by the Gemini Flash line. */
export const GOOGLE_FLASH_THINKING_LEVELS: readonly GoogleThinkingLevel[] = [
  'minimal',
  'low',
  'medium',
  'high',
];

/** Gemini 3 Pro restricts thinking to low/high (no minimal/medium). */
export const GOOGLE_PRO_THINKING_LEVELS: readonly GoogleThinkingLevel[] = ['low', 'high'];

/**
 * Gemini 3.7 Flash accepts low/medium/high and rejects minimal.
 * https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash (retrieved 2026-08-20)
 */
const GOOGLE_GEMINI_37_FLASH_THINKING_LEVELS: readonly GoogleThinkingLevel[] = [
  'low',
  'medium',
  'high',
];

/**
 * Whether a model ID is a Gemini 3.x Pro model (e.g. gemini-3-pro-preview,
 * gemini-3.1-pro-preview). Single source of truth shared by the settings UI
 * and the runtime provider-options builder so a Pro model never offers a
 * thinking level the runtime would silently drop.
 */
export function isGemini3ProModel(modelName: string | undefined): boolean {
  // Anchored at the start with a trailing token boundary so it matches
  // gemini-3-pro / gemini-3.1-pro-preview but not gemini-3.1-production or an
  // unrelated string that merely contains "gemini-3.x-pro".
  return Boolean(modelName && /^gemini-3(?:\.\d+)?-pro(?:-|$)/.test(modelName));
}

/** The thinking levels valid for the given Google model. */
export function getGoogleThinkingLevels(
  modelName: string | undefined
): readonly GoogleThinkingLevel[] {
  if (isGemini3ProModel(modelName)) {
    return GOOGLE_PRO_THINKING_LEVELS;
  }
  // Keep this exact. Aliases and sibling variants require their own evidence;
  // prefix matching could incorrectly narrow a future Flash-Lite ladder.
  return modelName === 'gemini-3.7-flash'
    ? GOOGLE_GEMINI_37_FLASH_THINKING_LEVELS
    : GOOGLE_FLASH_THINKING_LEVELS;
}

/**
 * Tri-state activation for local runtime providers (ollama / lmstudio):
 *  - `auto`: follow detection — show the provider only when probing succeeds.
 *  - `on`:   force-enabled regardless of detection (useful for remote
 *            runtimes behind a VPN/tunnel where local probes may flap).
 *  - `off`:  force-disabled — hide entirely even if the server is reachable.
 *
 * Defaults to `auto` when unset. Unused for hosted providers.
 */
export type LocalRuntimeActivation = 'auto' | 'on' | 'off';

export interface AssistantProviderSettings {
  /** Optional hard cap for request input tokens. Values are normalized to positive integers at runtime. */
  agentInputTokenLimit?: number;
  /** Optional Mastra agent loop step cap. Values are normalized to positive integers at runtime. */
  agentMaxSteps?: number;
  anthropicEffort?: AnthropicEffort;
  anthropicThinkingBudgetTokens?: number;
  /**
   * Bedrock reasoning DEPTH. Deliberately its own key rather than a reuse of
   * `anthropicEffort`: Bedrock's effort ladder is per-model (the adaptive
   * Claude routes, the legacy budget-token route and Amazon Nova each accept a
   * different set), and Bedrock exposes no free-form thinking BUDGET control,
   * so `anthropicThinkingBudgetTokens` has no meaning there. Sharing the
   * Anthropic key would let the Anthropic Thinking toggle write a budget that
   * the Bedrock request builder silently ignores — a switch that reads on while
   * nothing is requested.
   */
  bedrockEffort?: BedrockReasoningEffort;
  googleIncludeThoughts?: boolean;
  googleThinkingLevel?: GoogleThinkingLevel;
  /**
   * Origin override for local runtime providers (ollama / lmstudio). Empty
   * or undefined means "use the runtime's default (127.0.0.1 + standard
   * port)". Stored raw — normalized at the boundary when read by probes
   * or the provider factory. Unused for hosted providers.
   */
  localRuntimeBaseUrl?: string;
  /**
   * Tri-state activation for local runtime providers (ollama / lmstudio).
   * Defaults to `auto` when unset. Unused for hosted providers.
   */
  localRuntimeEnabled?: LocalRuntimeActivation;
  localThinkingEnabled?: boolean;
  maxOutputTokens?: number;
  memoryLastMessages?: number;
  reasoningEffort?: OpenAiReasoningEffort;
  reasoningSummary?: OpenAiReasoningSummary;
  /**
   * "Show me the thinking" switch, defaulting to `true` — when a model
   * reasons, the reasoning comes back and the disclosure has something to
   * reveal.
   *
   * DELIBERATELY orthogonal to reasoning DEPTH (`reasoningEffort`,
   * `anthropicEffort`, `googleThinkingLevel`, ...). Depth is a budget concern;
   * visibility is a UX concern. Conflating them is what made every provider
   * behave differently.
   *
   * Uniform in MEANING across providers, but stored per provider like every
   * key here (`providerSettings[providerId]`) — turning it off for OpenAI
   * leaves Anthropic visible. The provider-specific keys above remain valid
   * escape hatches and win when explicitly set.
   */
  reasoningVisible?: boolean;
  workingMemoryEnabled?: boolean;
}

export const assistantProviderSettingKeys = [
  'agentInputTokenLimit',
  'agentMaxSteps',
  'anthropicEffort',
  'anthropicThinkingBudgetTokens',
  'bedrockEffort',
  'googleIncludeThoughts',
  'googleThinkingLevel',
  'localRuntimeBaseUrl',
  'localRuntimeEnabled',
  'localThinkingEnabled',
  'maxOutputTokens',
  'memoryLastMessages',
  'reasoningEffort',
  'reasoningSummary',
  'reasoningVisible',
  'workingMemoryEnabled',
] as const satisfies readonly (keyof AssistantProviderSettings)[];

const assertNoMissingAssistantProviderSettingKeys = <_MissingKeys extends never>(): void =>
  undefined;

assertNoMissingAssistantProviderSettingKeys<
  Exclude<keyof AssistantProviderSettings, (typeof assistantProviderSettingKeys)[number]>
>();

export type ProviderSettingsUpdate<Settings extends object> = {
  [Key in keyof Settings]?: Settings[Key] | undefined;
};

export type AssistantProviderSettingsUpdate = ProviderSettingsUpdate<AssistantProviderSettings>;

type RequiredSettingsKey<Settings extends object> = {
  [Key in keyof Settings]-?: Record<string, never> extends Pick<Settings, Key> ? never : Key;
}[keyof Settings];

type OptionalSettingsBag<Settings extends object> =
  RequiredSettingsKey<Settings> extends never ? Settings : never;

/**
 * Merges all-optional provider settings bags. Present `undefined` deletes a setting,
 * so records with required properties are rejected at compile time.
 */
export function mergeProviderSettings<Settings extends object>(
  current: OptionalSettingsBag<Settings> | undefined,
  updates: ProviderSettingsUpdate<OptionalSettingsBag<Settings>>,
  allowedKeys: readonly (keyof OptionalSettingsBag<Settings>)[]
): OptionalSettingsBag<Settings> {
  const merged: Partial<OptionalSettingsBag<Settings>> = { ...(current ?? {}) };
  for (const key of allowedKeys) {
    if (!Object.hasOwn(updates, key)) {
      continue;
    }
    const value = updates[key] as OptionalSettingsBag<Settings>[typeof key] | undefined;
    if (value === undefined) {
      // Present `undefined` deletes a setting; omit the key to preserve the current value.
      delete merged[key];
      continue;
    }
    merged[key] = value;
  }
  return merged as OptionalSettingsBag<Settings>;
}

export function mergeAssistantProviderSettings(
  current: AssistantProviderSettings | undefined,
  updates: AssistantProviderSettingsUpdate
): AssistantProviderSettings {
  return mergeProviderSettings<AssistantProviderSettings>(
    current,
    updates,
    assistantProviderSettingKeys
  );
}

/**
 * Provider-id keyed settings map used by UI components that don't carry
 * the `SupportedProvider` brand. Preferences narrows this further to
 * `Record<SupportedProvider, AssistantProviderSettings>` locally.
 */
export type AssistantProviderSettingsMap = Record<string, AssistantProviderSettings>;
