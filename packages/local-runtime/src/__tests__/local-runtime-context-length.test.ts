import { describe, expect, it } from 'vitest';
import { parseOllamaContextLength } from '../local-runtime-model-parsing';

/** BST-754: the native context an Ollama model reports in `/api/show`'s `model_info`. */
describe('parseOllamaContextLength', () => {
  it('reads the architecture key, ignoring an auxiliary encoder', () => {
    expect(
      parseOllamaContextLength({
        model_info: {
          'clip.context_length': 512,
          'gemma4.context_length': 262_144,
          'general.architecture': 'gemma4',
        },
      })
    ).toEqual({ key: 'gemma4.context_length', state: 'reported', tokens: 262_144 });
  });

  it('reads the only context key when no architecture is named', () => {
    expect(parseOllamaContextLength({ model_info: { 'llama.context_length': 8192 } })).toEqual({
      key: 'llama.context_length',
      state: 'reported',
      tokens: 8192,
    });
  });

  it.each<[unknown, string]>([
    [{}, 'no model_info'],
    [{ model_info: 'gemma' }, 'a model_info that is not an object'],
    [{ model_info: { 'general.architecture': 'gemma4' } }, 'no context key'],
    [null, 'a payload that is not an object'],
  ])('is unreported for %j (%s)', (payload) => {
    expect(parseOllamaContextLength(payload)).toEqual({ state: 'unreported' });
  });

  it('is malformed, never a guess, for disagreeing keys or a value that is not a positive integer', () => {
    expect(
      parseOllamaContextLength({
        model_info: { 'a.context_length': 4096, 'b.context_length': 8192 },
      })
    ).toEqual({
      detail: 'conflicting context lengths in a.context_length, b.context_length',
      state: 'malformed',
    });
    for (const value of [0, -1, 1.5, '8192', null]) {
      expect(
        parseOllamaContextLength({
          model_info: { 'general.architecture': 'x', 'x.context_length': value },
        }),
        String(value)
      ).toEqual({ detail: 'x.context_length is not a positive integer', state: 'malformed' });
    }
  });
});
