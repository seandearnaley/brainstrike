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
  agentInputTokenLimit?: number;
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

export type AssistantProviderSettingsUpdate = {
  [Key in keyof AssistantProviderSettings]?: AssistantProviderSettings[Key] | undefined;
};

/**
 * Provider-id keyed settings map used by UI components that don't carry
 * the `SupportedProvider` brand. Preferences narrows this further to
 * `Record<SupportedProvider, AssistantProviderSettings>` locally.
 */
export type AssistantProviderSettingsMap = Record<string, AssistantProviderSettings>;
