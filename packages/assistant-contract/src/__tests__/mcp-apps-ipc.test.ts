import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMcpAppToolInvocationResult,
  MCP_APPS_IPC_CHANNELS,
  McpAppPrepareRequestSchema,
  McpAppToolInvocationResultSchema,
  parseMcpAppPrepareResult,
  readMcpAppToolInvocationResult,
} from '../mcp-apps-ipc.js';

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it('never schema-walks a result that does not carry the app marker kind', () => {
    const safeParse = vi.spyOn(McpAppToolInvocationResultSchema, 'safeParse');
    const large = {
      content: Array.from({ length: 5000 }, (_, index) => ({ text: `row ${index}`, type: 'text' })),
      structuredContent: { rows: Array.from({ length: 5000 }, (_, index) => ({ index })) },
    };
    expect(readMcpAppToolInvocationResult(large)).toBeUndefined();
    expect(readMcpAppToolInvocationResult({ ...large, kind: 'mcp-task' })).toBeUndefined();
    expect(readMcpAppToolInvocationResult('mcp-app')).toBeUndefined();
    expect(readMcpAppToolInvocationResult(null)).toBeUndefined();
    expect(readMcpAppToolInvocationResult(['mcp-app'])).toBeUndefined();
    expect(safeParse).not.toHaveBeenCalled();

    // The right kind still goes through the exact-shape schema: a near miss
    // stays an ordinary result (undefined), never a throw.
    expect(readMcpAppToolInvocationResult({ kind: 'mcp-app', result: {} })).toBeUndefined();
    expect(safeParse).toHaveBeenCalledTimes(1);
    const marker = createMcpAppToolInvocationResult(origin, {});
    expect(readMcpAppToolInvocationResult(marker)).toEqual(marker);
    expect(safeParse).toHaveBeenCalledTimes(2);
  });

  it('validates prepare requests and results strictly', () => {
    const request = {
      arguments: {},
      origin,
      preparationId: 'prep-1',
      threadId: 'thread-a',
      toolName: 'get-time',
    };
    expect(McpAppPrepareRequestSchema.parse(request)).toEqual(request);
    expect(() => McpAppPrepareRequestSchema.parse({ ...request, decision: 'allow' })).toThrow();
    expect(() => McpAppPrepareRequestSchema.parse({ ...request, preparationId: '' })).toThrow();
    // The owning thread is mandatory: admission is resolved per thread.
    expect(() => McpAppPrepareRequestSchema.parse({ ...request, threadId: '' })).toThrow();
    expect(() => {
      const { threadId: _omitted, ...withoutThread } = request;
      McpAppPrepareRequestSchema.parse(withoutThread);
    }).toThrow();
    expect(parseMcpAppPrepareResult({ decision: 'ask', riskCategory: 'ordinary' })).toEqual({
      decision: 'ask',
      riskCategory: 'ordinary',
    });
    expect(() => parseMcpAppPrepareResult({ decision: 'deny', riskCategory: 'x' })).toThrow();
  });
});
