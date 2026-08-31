import {
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { classifyMcpLifecycleFailure, McpLifecycleFailure } from '../../mcp/lifecycle-errors';

describe('classifyMcpLifecycleFailure', () => {
  it.each([
    [
      Object.assign(new Error('spawn failed'), { code: 'ENOENT' }),
      [],
      ['configuration', 'mcp-spawn-not-found'],
    ],
    [
      new Error('connection closed'),
      [{ message: "Cannot find package 'mcp-remote'", stream: 'stderr', truncated: false }],
      ['configuration', 'mcp-package-resolution-failed'],
    ],
    [
      new Error('MCP stdio connection closed during initialization'),
      [],
      ['connection', 'mcp-child-exited'],
    ],
    [
      new SdkError(SdkErrorCode.RequestTimeout, 'request timed out'),
      [],
      ['protocol', 'mcp-protocol-timeout'],
    ],
    [
      new SdkHttpError(SdkErrorCode.ClientHttpAuthentication, 'unauthorized', {
        status: 401,
      }),
      [],
      ['authentication', 'mcp-authentication-required'],
    ],
    [new UnauthorizedError(), [], ['authentication', 'mcp-authentication-required']],
    [
      new SdkHttpError(SdkErrorCode.ClientHttpForbidden, 'forbidden', { status: 403 }),
      [],
      ['authorization', 'mcp-server-rejected'],
    ],
    [
      new ProtocolError(ProtocolErrorCode.InternalError, 'server rejected request'),
      [],
      ['operation', 'mcp-server-rejected'],
    ],
    [
      Object.assign(new Error('open failed'), { code: 'browser_open_failed' }),
      [],
      ['authentication', 'mcp-browser-open-failed'],
    ],
    [
      Object.assign(new Error('callback expired'), { code: 'callback_timeout' }),
      [],
      ['authentication', 'mcp-auth-callback-timeout'],
    ],
  ] as const)('classifies %# without copying private messages', (cause, diagnostics, expected) => {
    const failure = classifyMcpLifecycleFailure(cause, diagnostics);
    expect(failure).toBeInstanceOf(McpLifecycleFailure);
    expect([failure.category, failure.code]).toEqual(expected);
    expect(failure.message).not.toContain(cause.message);
  });
});
