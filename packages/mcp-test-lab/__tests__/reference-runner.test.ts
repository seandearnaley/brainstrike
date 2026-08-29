import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { isMissingToolProtocolError } from '../src/reference-runner';

describe('MCP reference runner RED control', () => {
  it.each([
    [
      new ProtocolError(ProtocolErrorCode.InvalidParams, 'Tool missing-red-mutation not found'),
      true,
    ],
    [new Error('Tool missing-red-mutation not found'), false],
    [new ProtocolError(ProtocolErrorCode.InternalError, 'missing-red-mutation'), false],
    [new ProtocolError(ProtocolErrorCode.InvalidParams, 'another tool failed'), false],
  ])('accepts only the intended structured missing-tool rejection', (error, expected) => {
    expect(isMissingToolProtocolError(error, 'missing-red-mutation')).toBe(expected);
  });
});
