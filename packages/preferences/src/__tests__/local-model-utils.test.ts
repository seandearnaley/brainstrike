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
        providerId: 'local',
        isEnabled: true,
        capabilities: { type: 'llm' },
      })
    ).toBe(true);

    expect(
      isEnabledLocalLlmModel({
        providerId: 'local',
        isEnabled: true,
        capabilities: null,
      })
    ).toBe(false);
  });

  it('finds enabled local llm models within model arrays', () => {
    expect(
      hasEnabledLocalLlmModels([
        {
          providerId: 'openai',
          isEnabled: true,
          capabilities: { type: 'llm' },
        },
        {
          providerId: 'transformers',
          isEnabled: true,
          capabilities: { type: 'llm' },
        },
      ])
    ).toBe(true);

    expect(
      hasEnabledLocalLlmModels([
        {
          providerId: 'transformers',
          isEnabled: true,
          capabilities: null,
        },
      ])
    ).toBe(false);
  });
});
