import {
  AssistantRequestBodyLimitConfigError,
  HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES,
} from '@brainstrike/agent/request-boundary';
import { describe, expect, it } from 'vitest';
import { resolveWebAssistantRequestBodyLimitBytes } from '../web-assistant-body-limit';

describe('resolveWebAssistantRequestBodyLimitBytes', () => {
  it('defaults to the explicit Web transport ceiling', () => {
    expect(resolveWebAssistantRequestBodyLimitBytes(undefined)).toBe(
      HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES
    );
    expect(resolveWebAssistantRequestBodyLimitBytes('   ')).toBe(
      HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES
    );
  });

  it('allows configuration to lower the Web ceiling', () => {
    expect(resolveWebAssistantRequestBodyLimitBytes('1024')).toBe(1024);
  });

  it('rejects configuration above the Web ceiling instead of silently clamping it', () => {
    expect(() =>
      resolveWebAssistantRequestBodyLimitBytes(
        String(HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES * 2)
      )
    ).toThrow(
      `BRAINSTRIKE_ASSISTANT_REQUEST_BODY_LIMIT_BYTES cannot exceed the Hosted Web ceiling of ${HOSTED_WEB_ASSISTANT_REQUEST_BODY_LIMIT_BYTES} bytes`
    );
  });

  it('rejects malformed configuration instead of silently using the Web ceiling', () => {
    expect(() => resolveWebAssistantRequestBodyLimitBytes('invalid')).toThrow(
      'BRAINSTRIKE_ASSISTANT_REQUEST_BODY_LIMIT_BYTES must be a positive safe integer byte count'
    );
  });

  it('rejects an unsafe integer as malformed without echoing its value', () => {
    const configuredValue = String(Number.MAX_SAFE_INTEGER + 1);

    try {
      resolveWebAssistantRequestBodyLimitBytes(configuredValue);
    } catch (error) {
      expect(error).toBeInstanceOf(AssistantRequestBodyLimitConfigError);
      expect((error as Error).message).toContain(
        'BRAINSTRIKE_ASSISTANT_REQUEST_BODY_LIMIT_BYTES must be a positive safe integer byte count'
      );
      expect((error as Error).message).not.toContain(configuredValue);
      return;
    }

    throw new Error('Expected unsafe Web request body configuration to throw.');
  });
});
