import {
  createMcpAppToolInvocationResult,
  MCP_APPS_MIME_TYPE,
  type PermissionToolGateSnapshot,
} from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import type { HostThreadGrants } from '../src/core-state.js';
import { decideHostMcpAppCall } from '../src/mcp-app-calls.js';
import type { HostLogRow } from '../src/protocol.js';

const app = {
  mimeType: MCP_APPS_MIME_TYPE,
  resourceUri: 'ui://counter/app.html',
  serverId: 'counter',
  toolName: 'increment',
} as const;
// The committed output of the app tool's model call, from the producer the MCP runtime uses.
const mounted: HostLogRow = {
  event: {
    output: createMcpAppToolInvocationResult(app, { content: [{ text: 'count 1', type: 'text' }] }),
    runId: 'run-1',
    toolCallId: 'call-1',
    type: 'effect.finished',
  },
  seq: 4,
  threadId: 'thread-a',
};
const policy = (mcp: 'allow' | 'ask' | 'deny', overrides = {}): PermissionToolGateSnapshot => ({
  perToolOverrides: overrides,
  policies: { edit: 'ask', execute: 'ask', mcp, read: 'allow' },
  yolo: false,
});
const none = (): HostThreadGrants => ({ categories: new Set(), tools: new Set() });
const call = { app, toolName: 'increment' };

describe("an MCP App's own tool call on a host thread", () => {
  it("meets the thread's live policy and grants, as the model's call of that tool does", () => {
    expect(decideHostMcpAppCall([mounted], policy('ask'), none(), call)).toBe('ask');
    expect(decideHostMcpAppCall([mounted], policy('allow'), none(), call)).toBe('allow');
    const granted = none();
    granted.tools.add('counter.increment');
    expect(decideHostMcpAppCall([mounted], policy('ask'), granted, call)).toBe('allow');
  });

  it('is refused when the policy denies the tool, whatever the grants', () => {
    const granted = none();
    granted.categories.add('mcp');
    expect(() =>
      decideHostMcpAppCall(
        [mounted],
        policy('allow', { 'counter.increment': 'deny' }),
        granted,
        call
      )
    ).toThrow('The permission policy denies this MCP App tool call');
  });

  it("is refused unless one of the thread's committed results mounted that app", () => {
    expect(() => decideHostMcpAppCall([], policy('allow'), none(), call)).toThrow(
      'No committed tool result of this thread mounted this MCP App'
    );
    expect(() =>
      decideHostMcpAppCall([mounted], policy('allow'), none(), {
        app: { ...app, serverId: 'other' },
        toolName: 'increment',
      })
    ).toThrow('No committed tool result of this thread mounted this MCP App');
  });
});
