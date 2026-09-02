import { describe, expect, it } from 'vitest';
import {
  createMcpAppToolInvocationResult,
  MCP_APPS_IPC_CHANNELS,
  McpAppPrepareRequestSchema,
  parseMcpAppPrepareResult,
  readMcpAppToolInvocationResult,
} from '../mcp-apps-ipc.js';

const origin = {
  mimeType: 'text/html;profile=mcp-app',
  resourceUri: 'ui://get-time/mcp-app.html',
  serverId: 'apps-example',
  toolName: 'get-time',
} as const;

describe('MCP Apps IPC contract', () => {
  it('pins the channel names preload and main share', () => {
    expect(MCP_APPS_IPC_CHANNELS).toEqual({
      execute: 'mcp:apps:execute',
      prepare: 'mcp:apps:prepare',
      release: 'mcp:apps:release',
    });
    expect(Object.isFrozen(MCP_APPS_IPC_CHANNELS)).toBe(true);
  });

  it('round-trips the persisted app tool result exactly and rejects near misses', () => {
    const marker = createMcpAppToolInvocationResult(origin, { time: '2026-09-02T00:00:00Z' });
    expect(readMcpAppToolInvocationResult(marker)).toEqual(marker);
    expect(readMcpAppToolInvocationResult({ ...marker, extra: 1 })).toBeUndefined();
    expect(readMcpAppToolInvocationResult({ kind: 'mcp-app', result: {} })).toBeUndefined();
    expect(readMcpAppToolInvocationResult({ content: [] })).toBeUndefined();
    expect(() =>
      createMcpAppToolInvocationResult({ ...origin, mimeType: 'text/html' } as never, {})
    ).toThrow();
    expect(() =>
      createMcpAppToolInvocationResult({ ...origin, resourceUri: 'https://x' }, {})
    ).toThrow();
  });

  it('validates prepare requests and results strictly', () => {
    const request = { arguments: {}, origin, preparationId: 'prep-1', toolName: 'get-time' };
    expect(McpAppPrepareRequestSchema.parse(request)).toEqual(request);
    expect(() => McpAppPrepareRequestSchema.parse({ ...request, decision: 'allow' })).toThrow();
    expect(() =>
      McpAppPrepareRequestSchema.parse({ arguments: {}, origin, preparationId: '', toolName: 't' })
    ).toThrow();
    expect(parseMcpAppPrepareResult({ decision: 'ask', riskCategory: 'ordinary' })).toEqual({
      decision: 'ask',
      riskCategory: 'ordinary',
    });
    expect(() => parseMcpAppPrepareResult({ decision: 'deny', riskCategory: 'x' })).toThrow();
  });
});
