/**
 * Cross-cutting type definitions for assistant provider settings.
 *
 * These types are intentionally hosted in `@brainstrike/types` (a leaf
 * package with no runtime deps) so both `@brainstrike/ui` and
 * `@brainstrike/preferences` can share a single canonical definition.
 *
 * Previously the same shapes were duplicated in
 * `packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx` and
 * `packages/preferences/src/stores/assistant-preferences-store.ts` because
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

export type OpenAiReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type OpenAiReasoningSummary = 'auto' | 'detailed';
export type AnthropicEffort = 'low' | 'medium' | 'high';
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
 * Whether a model ID is a Gemini 3.x Pro model (e.g. gemini-3-pro-preview,
 * gemini-3.1-pro-preview). Single source of truth shared by the settings UI
 * and the runtime provider-options builder so a Pro model never offers a
 * thinking level the runtime would silently drop.
 */
export function isGemini3ProModel(modelName: string | undefined): boolean {
  // Anchored at the start: callers pass bare Google model IDs, so this matches
  // gemini-3-pro-preview / gemini-3.1-pro-preview but not an unrelated string
  // that merely contains "gemini-3.x-pro".
  return Boolean(modelName && /^gemini-3(?:\.\d+)?-pro/.test(modelName));
}

/** The thinking levels valid for the given Google model. */
export function getGoogleThinkingLevels(
  modelName: string | undefined
): readonly GoogleThinkingLevel[] {
  return isGemini3ProModel(modelName) ? GOOGLE_PRO_THINKING_LEVELS : GOOGLE_FLASH_THINKING_LEVELS;
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
  workingMemoryEnabled?: boolean;
}

export const assistantProviderSettingKeys = [
  'agentInputTokenLimit',
  'agentMaxSteps',
  'anthropicEffort',
  'anthropicThinkingBudgetTokens',
  'googleIncludeThoughts',
  'googleThinkingLevel',
  'localRuntimeBaseUrl',
  'localRuntimeEnabled',
  'localThinkingEnabled',
  'maxOutputTokens',
  'memoryLastMessages',
  'reasoningEffort',
  'reasoningSummary',
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
