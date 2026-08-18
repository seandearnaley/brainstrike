import { describe, expect, it } from 'vitest';
import {
  buildProviderOptions,
  reconcileProviderSettingsForModel,
} from '../assistant-ui-panel-wrapper-runtime';

/**
 * BST-1354: Bedrock reasoning is mapped per the model's REGISTRY dialect, and
 * the shared reasoning-visibility switch projects onto the one dialect that
 * has a wire knob for it (`adaptive`'s `display`).
 */
describe('buildProviderOptions for bedrock', () => {
  const ADAPTIVE_MODEL = 'anthropic.claude-sonnet-5';
  const BUDGET_MODEL = 'anthropic.claude-haiku-4-5-20251001-v1:0';
  const NOVA_MODEL = 'amazon.nova-2-lite-v1:0';

  it('maps an effort on an adaptive Claude route to the adaptive config, visible by default', () => {
    expect(buildProviderOptions('bedrock', ADAPTIVE_MODEL, { bedrockEffort: 'high' })).toEqual({
      bedrock: {
        reasoningConfig: { display: 'summarized', maxReasoningEffort: 'high', type: 'adaptive' },
      },
    });
  });

  it('honors the shared visibility switch on the adaptive route', () => {
    expect(
      buildProviderOptions('bedrock', ADAPTIVE_MODEL, {
        bedrockEffort: 'medium',
        reasoningVisible: false,
      })
    ).toEqual({
      bedrock: {
        reasoningConfig: { display: 'omitted', maxReasoningEffort: 'medium', type: 'adaptive' },
      },
    });
  });

  it('maps the legacy budget-token route to an explicit token budget', () => {
    expect(buildProviderOptions('bedrock', BUDGET_MODEL, { bedrockEffort: 'high' })).toEqual({
      bedrock: { reasoningConfig: { budgetTokens: 16_000, type: 'enabled' } },
    });
    expect(buildProviderOptions('bedrock', BUDGET_MODEL, { bedrockEffort: 'max' })).toEqual({
      bedrock: { reasoningConfig: { budgetTokens: 31_999, type: 'enabled' } },
    });
  });

  it('carries no display on the budget-token route (the form has no visibility knob)', () => {
    expect(
      buildProviderOptions('bedrock', BUDGET_MODEL, {
        bedrockEffort: 'high',
        reasoningVisible: false,
      })
    ).toEqual({
      bedrock: { reasoningConfig: { budgetTokens: 16_000, type: 'enabled' } },
    });
  });

  it('maps Amazon Nova to maxReasoningEffort with no token budget', () => {
    expect(buildProviderOptions('bedrock', NOVA_MODEL, { bedrockEffort: 'low' })).toEqual({
      bedrock: { reasoningConfig: { maxReasoningEffort: 'low', type: 'enabled' } },
    });
  });

  it('sends nothing when the user has chosen no effort (Auto / thinking off)', () => {
    expect(buildProviderOptions('bedrock', ADAPTIVE_MODEL, {})).toBeUndefined();
    expect(buildProviderOptions('bedrock', NOVA_MODEL, {})).toBeUndefined();
  });

  it('sends nothing for a route that declares no reasoning dialect', () => {
    // Nova v1 caches but does not reason; DeepSeek does neither. A stale
    // persisted effort must not manufacture a config these routes reject.
    expect(
      buildProviderOptions('bedrock', 'amazon.nova-pro-v1:0', { bedrockEffort: 'high' })
    ).toBeUndefined();
    expect(
      buildProviderOptions('bedrock', 'deepseek.v3.2', { bedrockEffort: 'high' })
    ).toBeUndefined();
  });

  it('sends nothing for an uncatalogued model id', () => {
    expect(
      buildProviderOptions('bedrock', 'anthropic.claude-not-in-catalog', { bedrockEffort: 'high' })
    ).toBeUndefined();
  });

  it('ignores an effort the route does not offer rather than sending it', () => {
    // `max` exists only on the budget-token ladder; an adaptive route that
    // inherited it from persisted state must not forward it.
    expect(
      buildProviderOptions('bedrock', ADAPTIVE_MODEL, { bedrockEffort: 'max' })
    ).toBeUndefined();
    expect(buildProviderOptions('bedrock', NOVA_MODEL, { bedrockEffort: 'xhigh' })).toBeUndefined();
  });

  it('clears an effort the newly selected route cannot offer', () => {
    // `max` exists only on the budget-token ladder. Carrying it onto an
    // adaptive route left the Effort control reading "Max" while the request
    // silently sent no reasoning at all — the control lying about the run.
    expect(
      reconcileProviderSettingsForModel('bedrock', ADAPTIVE_MODEL, { bedrockEffort: 'max' })
    ).toEqual({});
    expect(
      reconcileProviderSettingsForModel('bedrock', NOVA_MODEL, { bedrockEffort: 'xhigh' })
    ).toEqual({});
  });

  it('clears the effort when the newly selected route has no reasoning at all', () => {
    expect(
      reconcileProviderSettingsForModel('bedrock', 'amazon.nova-pro-v1:0', {
        bedrockEffort: 'high',
      })
    ).toEqual({});
  });

  it('keeps an effort the newly selected route does offer, and unrelated settings', () => {
    expect(
      reconcileProviderSettingsForModel('bedrock', ADAPTIVE_MODEL, {
        bedrockEffort: 'high',
        reasoningVisible: false,
      })
    ).toEqual({ bedrockEffort: 'high', reasoningVisible: false });
  });

  it('leaves an uncatalogued Bedrock model alone, mirroring the OpenRouter reconciler', () => {
    const settings = { bedrockEffort: 'max' } as const;
    expect(
      reconcileProviderSettingsForModel('bedrock', 'anthropic.claude-not-in-catalog', settings)
    ).toBe(settings);
  });

  it('reconciles nothing for providers that are not bedrock or openrouter', () => {
    const settings = { bedrockEffort: 'max' } as const;
    expect(reconcileProviderSettingsForModel('anthropic', 'claude-sonnet-5', settings)).toBe(
      settings
    );
  });

  it('does not read the Anthropic effort key', () => {
    // The two providers keep separate depth settings; sharing the key would
    // let an Anthropic budget toggle write state Bedrock silently drops.
    expect(
      buildProviderOptions('bedrock', ADAPTIVE_MODEL, {
        anthropicEffort: 'high',
        anthropicThinkingBudgetTokens: 8000,
      })
    ).toBeUndefined();
  });
});
