import { describe, expect, it } from 'vitest';
import {
  hasEnabledLocalLlmModels,
  isEnabledLocalLlmModel,
  isLocalModelProviderId,
} from '../models/local-model-utils';

describe('local-model-utils', () => {
  it('detects local provider ids', () => {
    expect(isLocalModelProviderId('local')).toBe(true);
    expect(isLocalModelProviderId('transformers')).toBe(true);
    expect(isLocalModelProviderId('openai')).toBe(false);
  });

  it('detects enabled local llm models safely', () => {
    expect(
      isEnabledLocalLlmModel({
        capabilities: { type: 'llm' },
        isEnabled: true,
        providerId: 'local',
      })
    ).toBe(true);

    expect(
      isEnabledLocalLlmModel({
        capabilities: null,
        isEnabled: true,
        providerId: 'local',
      })
    ).toBe(false);
  });

  it('finds enabled local llm models within model arrays', () => {
    expect(
      hasEnabledLocalLlmModels([
        {
          capabilities: { type: 'llm' },
          isEnabled: true,
          providerId: 'openai',
        },
        {
          capabilities: { type: 'llm' },
          isEnabled: true,
          providerId: 'transformers',
        },
      ])
    ).toBe(true);

    expect(
      hasEnabledLocalLlmModels([
        {
          capabilities: null,
          isEnabled: true,
          providerId: 'transformers',
        },
      ])
    ).toBe(false);
  });
});
