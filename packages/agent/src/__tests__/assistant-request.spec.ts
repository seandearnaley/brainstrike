import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES,
  resolveAssistantRequestBodyLimitBytes,
} from '../assistant-request';

describe('assistant request helpers', () => {
  it('uses the default request body byte limit when no override is configured', () => {
    expect(resolveAssistantRequestBodyLimitBytes(undefined)).toBe(
      DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES
    );
    expect(resolveAssistantRequestBodyLimitBytes('')).toBe(
      DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES
    );
  });

  it('accepts a positive integer request body byte limit override', () => {
    expect(resolveAssistantRequestBodyLimitBytes('5')).toBe(5);
  });

  it.each([
    '0',
    '-1',
    '1.5',
    'not-a-number',
  ])('throws for invalid request body byte limit override %s', (value) => {
    expect(() => resolveAssistantRequestBodyLimitBytes(value)).toThrow(
      'BRAINSTRIKE_ASSISTANT_REQUEST_BODY_LIMIT_BYTES must be a positive integer byte count'
    );
  });
});
