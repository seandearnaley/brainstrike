/**
 * The ONE prompt-rewriting model Proxy (BST-1354).
 *
 * Both prompt-caching dialects need the same thing: intercept `doStream` /
 * `doGenerate`, rewrite the outgoing prompt, delegate everything else. That
 * skeleton — and, more importantly, its two non-obvious LIMITS — lived twice
 * once Bedrock arrived, which is how the second copy quietly drifts. It lives
 * here once and the dialect modules supply only their pure transform.
 *
 * TWO DELIBERATE LIMITS, documented here and nowhere else:
 *
 *  1. Non-wrapped methods are re-bound on every property access, so method
 *     IDENTITY is not stable across reads (`m.foo !== m.foo`). No known
 *     consumer compares model method identity.
 *  2. Any path that reconstructs the model from serialized config — e.g. the
 *     SDK's workflow serialize/deserialize statics — yields an UNWRAPPED
 *     model. Brainstrike always re-creates models through `createProvider` on
 *     resume, so every live request path re-wraps.
 */

export interface PromptMessageLike {
  content?: unknown;
  providerOptions?: ModelProviderOptions;
  role?: unknown;
}

export interface PromptParamsLike {
  prompt?: readonly PromptMessageLike[];
}

export type ModelProviderOptions = Record<string, Record<string, unknown>>;

export interface ModelCallParamsLike extends PromptParamsLike {
  abortSignal?: AbortSignal;
  maxOutputTokens?: number;
  providerOptions?: ModelProviderOptions;
}

/** Pure, non-mutating rewrite of one request's prompt. */
export type PromptTransform = (params: PromptParamsLike) => PromptParamsLike;

export type ModelCallTransform = (params: ModelCallParamsLike) => ModelCallParamsLike;

type ModelCallMethod = (params: ModelCallParamsLike) => unknown;

const WRAPPED_CALL_METHODS = new Set(['doGenerate', 'doStream']);

/**
 * Wrap an AI SDK language model so every generation call goes out with
 * `transform` applied to its prompt. All other properties (spec version, ids,
 * capability probes) delegate to the wrapped model untouched.
 */
export function wrapModelWithPromptTransform<M extends object>(
  model: M,
  transform: PromptTransform
): M {
  return wrapModelWithCallTransform(model, (params) => transform(params));
}

/** Wrap every AI SDK generation call while preserving every other model capability. */
export function wrapModelWithCallTransform<M extends object>(
  model: M,
  transform: ModelCallTransform
): M {
  return new Proxy(model, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof property === 'string' && WRAPPED_CALL_METHODS.has(property)) {
        if (typeof value !== 'function') {
          return value;
        }
        const method = value as ModelCallMethod;
        return (params: ModelCallParamsLike) => method.call(target, transform(params));
      }
      if (typeof value === 'function') {
        return (value as (...args: unknown[]) => unknown).bind(target);
      }
      return value;
    },
  });
}
