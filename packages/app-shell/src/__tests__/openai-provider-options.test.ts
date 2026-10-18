import { describe, expect, it } from 'vitest';
import { reconcileProviderSettingsForModel } from '../assistant-ui-panel-wrapper-runtime';

/**
 * BST-1709: the direct OpenAI rows declare different ladders, and the effort
 * setting is provider-wide. An effort the next model does not offer is cleared
 * on the switch, so the control never shows (and the request never sends) one
 * that route rejects.
 */
describe('reconcileProviderSettingsForModel for openai', () => {
  it.each([
    ['none', 'gpt-5.5-pro'],
    ['max', 'gpt-5.5-pro'],
    ['max', 'gpt-5.5'],
    ['none', 'gpt-5.3-codex'],
    ['low', 'gpt-5.2-pro'],
  ] as const)('clears %s when switching to %s, keeping unrelated settings', (effort, model) => {
    expect(
      reconcileProviderSettingsForModel('openai', model, {
        maxOutputTokens: 4096,
        reasoningEffort: effort,
      })
    ).toEqual({ maxOutputTokens: 4096 });
  });

  it('keeps an effort the next model offers', () => {
    const settings = { reasoningEffort: 'high' } as const;
    expect(reconcileProviderSettingsForModel('openai', 'gpt-5.5-pro', settings)).toBe(settings);
    expect(
      reconcileProviderSettingsForModel('openai', 'gpt-5.6-sol', { reasoningEffort: 'max' })
    ).toEqual({ reasoningEffort: 'max' });
  });

  it('leaves an uncatalogued model and an unset effort alone', () => {
    const settings = { reasoningEffort: 'max' } as const;
    expect(reconcileProviderSettingsForModel('openai', 'gpt-not-in-catalog', settings)).toBe(
      settings
    );
    const unset = { maxOutputTokens: 1024 };
    expect(reconcileProviderSettingsForModel('openai', 'gpt-5.5-pro', unset)).toBe(unset);
  });
});
