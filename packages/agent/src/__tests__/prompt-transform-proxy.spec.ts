/**
 * BST-1742: `wrapModelWithCallTransform` must read with the TARGET as receiver.
 *
 * Mastra's `ModelRouterLanguageModel` and the AI SDK wrapper classes keep
 * their state in `#private` fields. Reading a prototype getter through the
 * proxy with the PROXY as receiver throws `TypeError: Cannot read private
 * member` (the same hazard `provider-call-warnings.ts` already guards
 * against); this wrapper is applied on live request paths, so it must be
 * safe against that whole set rather than just the adapters that happen to
 * use plain properties today.
 */
import { describe, expect, it } from 'vitest';
import {
  type ModelCallParamsLike,
  wrapModelWithCallTransform,
} from '../providers/prompt-transform-proxy';

class PrivateStateModel {
  readonly #modelId = 'private-model';

  get modelId(): string {
    return this.#modelId;
  }

  doGenerate(params: ModelCallParamsLike): Promise<{ maxOutputTokens: number | undefined }> {
    return Promise.resolve({ maxOutputTokens: params.maxOutputTokens });
  }
}

describe('prompt-transform-proxy receiver', () => {
  it('survives a model whose getters read #private state', () => {
    const wrapped = wrapModelWithCallTransform(new PrivateStateModel(), (params) => params);

    expect(wrapped.modelId).toBe('private-model');
  });

  it('still applies the transform to generation calls', async () => {
    const raw = new PrivateStateModel();
    const wrapped = wrapModelWithCallTransform(raw, (params) => ({
      ...params,
      maxOutputTokens: 7,
    }));

    await expect(wrapped.doGenerate({})).resolves.toEqual({ maxOutputTokens: 7 });
  });
});
