import { McpAppProvenanceAuthority, McpAppToolCallAuthority } from '@brainstrike/mcp-app-host';
import { describe, expect, it, vi } from 'vitest';
import { createMcpAppOrdinaryToolCallPreparer } from '../mastra/mcp-app-tool-call';
import type { AgentHookRunner } from '../tools/hook-runner';

function policy(decision: 'allow' | 'ask' | 'deny') {
  return {
    defaultRisk: 'mcp' as const,
    perToolOverrides: { 'linear.create_issue': decision },
    policies: {
      edit: 'ask' as const,
      execute: 'ask' as const,
      mcp: 'allow' as const,
      read: 'allow' as const,
    },
    riskByTool: { 'linear.create_issue': 'execute' as const },
    yolo: false,
  };
}

function setup(decision: 'allow' | 'ask' | 'deny', hookRunner?: AgentHookRunner) {
  const provenance = new McpAppProvenanceAuthority();
  const generation = provenance.openGeneration({ generation: 1, serverId: 'linear' });
  provenance.registerTool(generation, {
    _meta: { ui: { visibility: ['app'] } },
    name: 'create_issue',
  });
  const invoke = vi.fn(async () => ({ content: [{ text: 'created', type: 'text' }] }));
  const telemetry = vi.fn();
  const authority = new McpAppToolCallAuthority({
    generation,
    prepare: createMcpAppOrdinaryToolCallPreparer({
      ...(hookRunner ? { hookRunner } : {}),
      invoke,
      onTelemetry: telemetry,
      permissionSnapshot: policy(decision),
      timeoutMs: 100,
    }),
    provenance,
  });
  return { authority, invoke, telemetry };
}

describe('MCP Apps ordinary runtime adapter', () => {
  it('uses the shared permission resolver and never invokes ask/deny implicitly', async () => {
    const ask = setup('ask');
    const pending = ask.authority.call({ arguments: {}, id: 'ask', name: 'create_issue' });
    await vi.waitFor(() => expect(ask.authority.snapshot.pendingApprovals).toHaveLength(1));
    expect(ask.invoke).not.toHaveBeenCalled();
    ask.authority.approve(ask.authority.snapshot.pendingApprovals[0]?.id ?? 'missing');
    await expect(pending).resolves.toMatchObject({ content: [{ text: 'created' }] });

    const denied = setup('deny');
    await expect(
      denied.authority.call({ arguments: {}, id: 'deny', name: 'create_issue' })
    ).rejects.toMatchObject({ code: -32_001 });
    expect(denied.invoke).not.toHaveBeenCalled();
  });

  it('runs the ordinary guard and lifecycle hooks while keeping hook context out of app output', async () => {
    const order: string[] = [];
    const hookRunner: AgentHookRunner = {
      postToolUse: async () => {
        order.push('post');
        return { additionalContext: 'model-only context' };
      },
      preToolUse: async () => {
        order.push('pre');
        return { decision: 'allow' };
      },
    };
    const allowed = setup('allow', hookRunner);
    allowed.invoke.mockImplementationOnce(async (_call, { signal }) => {
      expect(signal.aborted).toBe(false);
      order.push('invoke');
      return { content: [{ text: 'safe output', type: 'text' }] };
    });

    await expect(
      allowed.authority.call({ arguments: { title: 'x' }, id: 1, name: 'create_issue' })
    ).resolves.toEqual({ content: [{ text: 'safe output', type: 'text' }] });
    expect(order).toEqual(['pre', 'invoke', 'post']);
    expect(allowed.telemetry).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'completed', toolName: 'linear.create_issue' })
    );
    expect(Object.keys(allowed.telemetry.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
      'durationMs',
      'outcome',
      'toolName',
    ]);
  });
});
