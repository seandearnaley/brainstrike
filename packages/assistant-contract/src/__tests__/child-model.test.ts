import { describe, expect, it } from 'vitest';
import {
  ChildModelError,
  childModelConfiguration,
  childModelEfforts,
  childModelIdentity,
} from '../child-model.js';
import { buildProviderOptions } from '../generation-options.js';

describe('childModelEfforts', () => {
  it('offers each model the part of the effort scale its own reasoning controls take', () => {
    expect(childModelEfforts('openai', 'gpt-6-astra')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(childModelEfforts('openai', 'gpt-6-sol')).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(childModelEfforts('google', 'gemini-3.8-flash')).toEqual(['low', 'medium', 'high']);
    expect(childModelEfforts('bedrock', 'anthropic.claude-opus-5')).toEqual([
      'low',
      'medium',
      'high',
    ]);
  });

  it('offers none on an Anthropic model that can stop thinking, and not on one that always thinks', () => {
    expect(childModelEfforts('anthropic', 'claude-opus-5')).toContain('none');
    expect(childModelEfforts('anthropic', 'claude-opus-5-5')).not.toContain('none');
  });

  it('offers nothing for a model with no reasoning control', () => {
    expect(childModelEfforts('openrouter', 'openai/gpt-6-astra')).toEqual([]);
  });
});

describe('childModelConfiguration', () => {
  it("builds the request options the composer would send for the model at the target's effort", () => {
    expect(
      childModelConfiguration({ effort: 'high', modelId: 'openai::gpt-6-astra' }, undefined)
    ).toEqual({
      model: 'gpt-6-astra',
      provider: 'openai',
      providerOptions: { openai: { reasoningEffort: 'high', reasoningSummary: 'auto' } },
    });
    expect(
      childModelConfiguration(
        { effort: 'max', modelId: 'openrouter::anthropic/claude-opus-5.5' },
        undefined
      ).providerOptions
    ).toEqual({
      openrouter: { provider: { ['require_parameters']: true }, reasoning: { effort: 'max' } },
    });
    expect(
      childModelConfiguration({ effort: 'low', modelId: 'google::gemini-3.8-flash' }, undefined)
        .providerOptions
    ).toEqual({ google: { thinkingConfig: { includeThoughts: true, thinkingLevel: 'low' } } });
  });

  it("turns an Anthropic model's thinking off at none", () => {
    expect(
      childModelConfiguration({ effort: 'none', modelId: 'anthropic::claude-opus-5' }, undefined)
        .providerOptions
    ).toEqual({ anthropic: { thinking: { type: 'disabled' } } });
  });

  it("without an effort, sends the model's own default, as the composer's Auto does", () => {
    expect(childModelConfiguration({ modelId: 'openai::gpt-6-sol' }, undefined)).toEqual({
      model: 'gpt-6-sol',
      provider: 'openai',
      ...(buildProviderOptions('openai', 'gpt-6-sol', {})
        ? { providerOptions: buildProviderOptions('openai', 'gpt-6-sol', {}) }
        : {}),
    });
  });

  it('refuses an effort the model does not take, naming the ones it does', () => {
    expect(() =>
      childModelConfiguration({ effort: 'none', modelId: 'anthropic::claude-opus-5-5' }, undefined)
    ).toThrow(
      new ChildModelError(
        'Claude Opus 5.5 takes effort low, medium, high, xhigh, max; "none" is not one of them.'
      )
    );
    expect(() =>
      childModelConfiguration(
        { effort: 'high', modelId: 'openrouter::openai/gpt-6-astra' },
        undefined
      )
    ).toThrow(/has no reasoning effort to set/u);
  });
});

describe('childModelIdentity', () => {
  it('reads a provider::model catalog ID and refuses anything else', () => {
    expect(childModelIdentity('openrouter::anthropic/claude-opus-5.5')).toEqual({
      model: 'anthropic/claude-opus-5.5',
      provider: 'openrouter',
    });
    for (const id of ['claude-opus-5', 'nowhere::model', 'openai::', '::gpt-6-sol']) {
      expect(() => childModelIdentity(id)).toThrow(ChildModelError);
    }
  });
});
