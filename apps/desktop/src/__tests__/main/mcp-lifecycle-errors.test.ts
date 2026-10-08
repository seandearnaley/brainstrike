import {
  classifyMcpConnectFailure,
  classifyMcpLifecycleFailure,
  McpLifecycleFailure,
} from '@brainstrike/host-capabilities/mcp/lifecycle-errors';
import {
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';

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

describe('classifyMcpConnectFailure', () => {
  const server = 'team.linear.prod';

  it('routes a bare connection fault to authentication-required after a discarded registration', () => {
    const failure = classifyMcpConnectFailure(new Error('connect failed'), undefined, {
      requiresReauthorization: true,
      server,
    });

    expect([failure.category, failure.code]).toEqual([
      'authentication',
      'mcp-authentication-required',
    ]);
    expect(failure.cause).toMatchObject({ code: 'mcp-connection-failed' });
  });

  it('leaves a bare connection fault alone when no registration was discarded', () => {
    const failure = classifyMcpConnectFailure(new Error('connect failed'), undefined, {
      requiresReauthorization: false,
      server,
    });

    expect([failure.category, failure.code]).toEqual(['connection', 'mcp-connection-failed']);
  });

  /**
   * A discarded registration must not erase an already-actionable diagnosis:
   * replacing `mcp-browser-open-failed` with another Connect button hides the
   * only fault the user can act on (BST-1597 review).
   */
  it.each([
    [
      Object.assign(new Error('open failed'), { code: 'browser_open_failed' }),
      ['authentication', 'mcp-browser-open-failed'],
    ],
    [
      Object.assign(new Error('callback expired'), { code: 'callback_timeout' }),
      ['authentication', 'mcp-auth-callback-timeout'],
    ],
    [
      new SdkHttpError(SdkErrorCode.ClientHttpForbidden, 'forbidden', { status: 403 }),
      ['authorization', 'mcp-server-rejected'],
    ],
    [
      new ProtocolError(ProtocolErrorCode.InternalError, 'server rejected request'),
      ['operation', 'mcp-server-rejected'],
    ],
    [
      new SdkError(SdkErrorCode.RequestTimeout, 'request timed out'),
      ['protocol', 'mcp-protocol-timeout'],
    ],
    [
      new SdkError(SdkErrorCode.ConnectionClosed, 'connection closed'),
      ['connection', 'mcp-child-exited'],
    ],
    [new UnauthorizedError(), ['authentication', 'mcp-authentication-required']],
  ] as const)('preserves classification %# after a discarded registration', (cause, expected) => {
    const failure = classifyMcpConnectFailure(cause, undefined, {
      requiresReauthorization: true,
      server,
    });

    expect([failure.category, failure.code]).toEqual(expected);
  });
});
