import { describe, expect, it } from 'vitest';
import {
  AssistantRequestBodyLimitConfigError,
  resolveAssistantRequestBodyLimitBytes,
} from '../assistant-request-body-limit';

describe('assistant request body limit', () => {
  it('accepts the largest positive safe integer byte limit', () => {
    expect(resolveAssistantRequestBodyLimitBytes(String(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER
    );
  });

  it('rejects an integer beyond the safe range without echoing its value', () => {
    const configuredValue = String(Number.MAX_SAFE_INTEGER + 1);

    expect(() => resolveAssistantRequestBodyLimitBytes(configuredValue)).toThrow(
      AssistantRequestBodyLimitConfigError
    );

    try {
      resolveAssistantRequestBodyLimitBytes(configuredValue);
    } catch (error) {
      expect(error).toBeInstanceOf(AssistantRequestBodyLimitConfigError);
      expect((error as Error).message).toContain(
        'BRAINSTRIKE_ASSISTANT_REQUEST_BODY_LIMIT_BYTES must be a positive safe integer byte count'
      );
      expect((error as Error).message).not.toContain(configuredValue);
      return;
    }

    throw new Error('Expected unsafe request body configuration to throw.');
  });

  it('rejects malformed configuration without echoing its value', () => {
    const configuredValue = 'sk-secret-looking-invalid-value';

    expect(() => resolveAssistantRequestBodyLimitBytes(configuredValue)).toThrow(
      AssistantRequestBodyLimitConfigError
    );

    try {
      resolveAssistantRequestBodyLimitBytes(configuredValue);
    } catch (error) {
      expect(error).toBeInstanceOf(AssistantRequestBodyLimitConfigError);
      expect((error as Error).message).toContain(
        'BRAINSTRIKE_ASSISTANT_REQUEST_BODY_LIMIT_BYTES must be a positive safe integer byte count'
      );
      expect((error as Error).message).not.toContain(configuredValue);
      return;
    }

    throw new Error('Expected malformed request body configuration to throw.');
  });
});
