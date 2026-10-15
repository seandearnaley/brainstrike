// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  getModelIdMigrationTarget,
  isRetiredModelId,
} from '../stores/assistant-model-id-migrations';

describe('assistant model id migrations', () => {
  it('distinguishes retired ids from live ids without relying on the replacement value', () => {
    expect(isRetiredModelId('openai', 'gpt-5.2-chat-latest')).toBe(true);
    expect(isRetiredModelId('openai', 'gpt-5.4')).toBe(false);
    expect(isRetiredModelId(undefined, 'gpt-5.2-chat-latest')).toBe(false);
  });

  it('returns the shared migration target for preference migration callers', () => {
    expect(getModelIdMigrationTarget('openai', 'gpt-5.2-chat-latest')).toBe('gpt-5.4');
    expect(getModelIdMigrationTarget('openai', 'gpt-5.4')).toBeNull();
  });
});
