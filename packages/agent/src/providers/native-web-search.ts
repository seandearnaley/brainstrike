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
import {
  type ProviderAuthInput,
  type ProviderFetchOptions,
  providerFetchOptions,
} from './provider-auth-input';

export { WEB_SEARCH_TOOL_ID };

/**
 * Mirror of provider-factory's `sdkFactorySettings`: preserve the historical
 * `apiKey ? { apiKey } : undefined` shape when nothing was projected.
 */
function webSearchClientSettings(options: ProviderFetchOptions): ProviderFetchOptions | undefined {
  if (options.apiKey === undefined && options.fetch === undefined) {
    return;
  }
  return options;
}

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
 * provider-instance-independent (the actual API auth rides on the language
 * model built separately), so the client built here exists for construction
 * parity — but that parity MUST include the full ProviderAuthInput (BST-1352
 * review finding 1): building it from a bare key would silently drop an
 * injected custom fetch, and under `custom_fetch` the dummy key would reach
 * the real API. `providerFetchOptions` is the same projection the chat model
 * uses, so the two clients can never diverge on auth kind handling (aws
 * throws typed here exactly like the chat case). Returns `undefined` for
 * providers without native search.
 */
export function createProviderNativeWebSearchTool(
  provider: string,
  auth: ProviderAuthInput | undefined
): ToolsInput[string] | undefined {
  if (provider === 'anthropic') {
    const anthropicProvider = createAnthropic(
      webSearchClientSettings(providerFetchOptions(auth, provider))
    );
    return anthropicProvider.tools.webSearch_20250305() as unknown as ToolsInput[string];
  }
  if (provider === 'openai') {
    // INVARIANT: `openai.tools.webSearch()` only executes on the Responses API
    // surface. This client is a FRESH `createOpenAI()`, decoupled from how
    // `provider-factory.ts`'s `case 'openai'` builds the actual chat model
    // (`openaiProvider(modelName)`) — it works today only because that default
    // callable also routes to `/v1/responses`. If the chat surface ever moves
    // off `/v1/responses` (e.g. `.chat(modelName)` or an OpenAI-compatible base
    // URL), this native tool must move with it — see the matching invariant
    // comment on the `case 'openai':` branch in provider-factory.ts. Both
    // clients now share `providerFetchOptions`, so the AUTH halves cannot
    // drift even while the surface halves stay independently pinned.
    const openaiProvider = createOpenAI(
      webSearchClientSettings(providerFetchOptions(auth, provider))
    );
    return openaiProvider.tools.webSearch() as unknown as ToolsInput[string];
  }
  return;
}

/** Minimal logger surface (a structural subset of the project ScopedLogger). */
interface NativeWebSearchLogger {
  info: (message: string, context?: Record<string, unknown>) => void;
}

export interface ApplyProviderNativeWebSearchParams {
  /**
   * Sanitized ids of tools the permission gate resolved to `ask` (kept as
   * approval-gated clones). Web search present here MUST stay Tavily-backed.
   */
  askTools: ReadonlyMap<string, unknown>;
  /**
   * The run's resolved ProviderAuthInput (BST-1352): the SAME input the chat
   * model was built with, so the web-search client shares its fetch/key.
   */
  auth: ProviderAuthInput | undefined;
  logger?: NativeWebSearchLogger;
  /**
   * Keep the execute-backed implementation while resuming a call that already
   * suspended against it. A permission grant may make the rebuilt runtime
   * eligible for native search, but replacing the implementation would orphan
   * Mastra's stored function invocation.
   */
  preserveExecuteBackedWebSearch?: boolean | undefined;
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
  const { auth, askTools, logger, preserveExecuteBackedWebSearch, provider, tools, toolNameMap } =
    params;

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

  if (preserveExecuteBackedWebSearch) {
    logger?.info('approval resume keeping the suspended execute-backed web search', {
      code: 'provider_native_web_search_approval_resume_keeps_tavily',
      provider,
    });
    return tools;
  }

  const nativeTool = createProviderNativeWebSearchTool(provider, auth);
  if (!nativeTool) {
    return tools;
  }

  logger?.info('using provider-native web search (allow) in place of Tavily', {
    code: 'provider_native_web_search_selected',
    provider,
  });
  return { ...tools, [sanitizedId]: nativeTool };
}
