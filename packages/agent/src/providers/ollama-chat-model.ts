import type { JSONObject, LanguageModelV4, LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { wrapLanguageModel } from 'ai';
import { createOllama } from 'ollama-ai-provider-v2';

/**
 * BST-754: what run admission read from an Ollama model's `/api/show`: the
 * window the run is budgeted against, which Ollama must allocate as
 * `num_ctx`, and whether the model thinks.
 */
export interface OllamaModelFacts {
  readonly contextWindow: number;
  readonly thinking: boolean;
}

/** Each call setting Ollama honors, and the `/api/chat` option it is sent as. */
const OLLAMA_OPTION_NAMES = [
  ['maxOutputTokens', 'num_predict'],
  ['seed', 'seed'],
  ['stopSequences', 'stop'],
  ['temperature', 'temperature'],
  ['topK', 'top_k'],
  ['topP', 'top_p'],
] as const;

/**
 * The `/api/chat` settings for one call: the admitted window (`num_ctx`) and
 * the call's own sampling settings, all inside `options` where Ollama reads
 * them (the provider also sends temperature, top_p and the output cap at the
 * top level, where `/api/chat` ignores them). `think` is set from the model's
 * reported capability: the provider would otherwise send false, and a model
 * without the capability rejects true.
 */
export function ollamaChatOptions(
  params: Pick<LanguageModelV4CallOptions, (typeof OLLAMA_OPTION_NAMES)[number][0]>,
  facts: OllamaModelFacts
): JSONObject {
  const options: JSONObject = Object.fromEntries([
    ['num_ctx', facts.contextWindow],
    ...OLLAMA_OPTION_NAMES.flatMap(([setting, option]) =>
      params[setting] === undefined ? [] : [[option, params[setting]]]
    ),
  ]);
  return { options, think: facts.thinking };
}

/**
 * An Ollama chat model on the native `/api/chat` (BST-754): the only Ollama
 * route that sizes the context per request; on the OpenAI-compatible `/v1`
 * route Ollama allocates its own default (gemma4:31b's native 262,144 tokens
 * while the budget said 32K). Every call this model makes, a run step, a
 * thread title or a compaction summary, carries the admitted window, so
 * Ollama never reloads the model at another size.
 */
export function createOllamaChatModel(options: {
  /** The local server's bearer token, when it requires one. */
  readonly apiToken?: string | undefined;
  readonly facts: OllamaModelFacts;
  readonly modelId: string;
  /** The runtime's origin, without `/api`. */
  readonly origin: string;
}): LanguageModelV4 {
  const provider = createOllama({
    baseURL: `${options.origin}/api`,
    ...(options.apiToken ? { headers: { authorization: `Bearer ${options.apiToken}` } } : {}),
  });
  return wrapLanguageModel({
    middleware: {
      specificationVersion: 'v4',
      transformParams: async ({ params }) => ({
        ...params,
        providerOptions: {
          ...params.providerOptions,
          ollama: ollamaChatOptions(params, options.facts),
        },
      }),
    },
    model: provider.chat(options.modelId),
  });
}
