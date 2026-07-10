/**
 * Provider-native web search selection.
 *
 * v1 policy (see the web-search study): prefer a PROVIDER-EXECUTED web-search
 * tool for the two providers that support combining it with function tools
 * unconditionally — Anthropic (`anthropic.tools.webSearch_20250305()`) and
 * OpenAI (`openai.tools.webSearch()`, on the Responses surface brainstrike
 * already uses). Google is DEFERRED: its SDK silently drops ALL function tools
 * when a provider tool is combined on pre-Gemini-3 models, which would violate
 * the no-silent-fallbacks rule. Every other provider (openrouter/ollama/
 * lmstudio/local) has no first-party native search.
 *
 * A provider-native tool is executed inside the provider's own infrastructure —
 * it has NO local `execute`, so Mastra has no suspend point in front of it and
 * it CANNOT be approval-gated. The single load-bearing safety rule enforced here
 * (`applyProviderNativeWebSearch`): only swap the native tool in when the
 * permission gate resolved web search to `allow`. When it resolved to `ask` (the
 * tool is in `askTools`) or `deny`/omitted (absent from the gated map), we leave
 * the execute-backed Tavily tool in place so the run can suspend for approval /
 * omit normally — never a silent downgrade of the user's explicit choice.
 *
 * The native tool is injected AFTER `sanitizeTools`/`applyToolGuards`/the
 * permission gate (see `createMastraAgentRuntime`), because `sanitizeTools`
 * rewrites a dotted tool key and CLOBBERS `tool.id` — and for a provider-defined
 * tool `id` (`anthropic.web_search_20250305`) is the provider's dispatch key, not
 * a cosmetic label.
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { WEB_SEARCH_TOOL_ID } from '@brainstrike/assistant-contract/tool-metadata';
import type { ToolsInput } from '@mastra/core/agent';

export { WEB_SEARCH_TOOL_ID };

/** Providers with a first-party, combinable native web-search tool (v1). */
export type NativeWebSearchProvider = 'anthropic' | 'openai';

const NATIVE_WEB_SEARCH_PROVIDERS: ReadonlySet<string> = new Set<NativeWebSearchProvider>([
  'anthropic',
  'openai',
]);

/**
 * True when `provider` exposes a provider-native web-search tool that combines
 * cleanly with function tools. Google is intentionally excluded (see module doc).
 */
export function providerSupportsNativeWebSearch(
  provider: string
): provider is NativeWebSearchProvider {
  return NATIVE_WEB_SEARCH_PROVIDERS.has(provider);
}

/**
 * Build the provider-executed web-search tool object for a supported provider.
 *
 * The returned object is a provider-defined tool (`{ type:'provider',
 * isProviderExecuted:true, id, args }`) with no `execute`. It is
 * provider-instance-independent (the actual API auth rides on the language model
 * built separately with the api key), so the key here is only for construction
 * parity and is never embedded in the tool. Returns `undefined` for providers
 * without native search.
 */
export function createProviderNativeWebSearchTool(
  provider: string,
  apiKey: string | undefined
): ToolsInput[string] | undefined {
  if (provider === 'anthropic') {
    const anthropicProvider = createAnthropic(apiKey ? { apiKey } : undefined);
    return anthropicProvider.tools.webSearch_20250305() as unknown as ToolsInput[string];
  }
  if (provider === 'openai') {
    const openaiProvider = createOpenAI(apiKey ? { apiKey } : undefined);
    return openaiProvider.tools.webSearch() as unknown as ToolsInput[string];
  }
  return;
}

/** Minimal logger surface (a structural subset of the project ScopedLogger). */
interface NativeWebSearchLogger {
  info: (message: string, context?: Record<string, unknown>) => void;
}

export interface ApplyProviderNativeWebSearchParams {
  /** The resolver's api key for the selected provider (rides on the model, not the tool). */
  apiKey: string | undefined;
  /**
   * Sanitized ids of tools the permission gate resolved to `ask` (kept as
   * approval-gated clones). Web search present here MUST stay Tavily-backed.
   */
  askTools: ReadonlyMap<string, unknown>;
  logger?: NativeWebSearchLogger;
  /** The resolved provider id for this run (e.g. `anthropic`). */
  provider: string;
  /** Sanitized id → original tool id, as recorded by `sanitizeTools`. */
  toolNameMap: ReadonlyMap<string, string>;
  /** The final, post-gate tool map (sanitized ids → tool objects). */
  tools: ToolsInput;
}

function findWebSearchSanitizedId(toolNameMap: ReadonlyMap<string, string>): string | undefined {
  for (const [sanitizedId, originalId] of toolNameMap) {
    if (originalId === WEB_SEARCH_TOOL_ID) {
      return sanitizedId;
    }
  }
  return;
}

/**
 * Return the tool map with the web-search entry swapped to the provider-native
 * tool WHEN AND ONLY WHEN it is safe: supported provider AND the gate resolved
 * web search to `allow` (present in the map, not in `askTools`). Otherwise the
 * map is returned unchanged (Tavily stays). Pure: never mutates its inputs.
 */
export function applyProviderNativeWebSearch(
  params: ApplyProviderNativeWebSearchParams
): ToolsInput {
  const { apiKey, askTools, logger, provider, tools, toolNameMap } = params;

  if (!providerSupportsNativeWebSearch(provider)) {
    return tools;
  }

  const sanitizedId = findWebSearchSanitizedId(toolNameMap);
  // Absent from the gated map (denied/omitted, or never registered) → nothing to
  // swap; a provider-native tool must never be conjured where the gate removed
  // web search entirely.
  if (!(sanitizedId && sanitizedId in tools)) {
    return tools;
  }

  // Resolved to `ask`: a provider-native tool cannot suspend for approval, so
  // keep the execute-backed Tavily tool that CAN. Load-bearing safety rule.
  if (askTools.has(sanitizedId)) {
    logger?.info(
      'web search gated to ask; keeping approval-gatable Tavily tool (provider-native cannot suspend)',
      { code: 'provider_native_web_search_ask_keeps_tavily', provider }
    );
    return tools;
  }

  const nativeTool = createProviderNativeWebSearchTool(provider, apiKey);
  if (!nativeTool) {
    return tools;
  }

  logger?.info('using provider-native web search (allow) in place of Tavily', {
    code: 'provider_native_web_search_selected',
    provider,
  });
  return { ...tools, [sanitizedId]: nativeTool };
}
