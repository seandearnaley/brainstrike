import type { HostClient } from '@brainstrike/agent-host/browser';
import { MCP_APPS_MIME_TYPE } from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import { hostMcpAppBridge } from '../host-mcp-app-bridge';

const origin = {
  mimeType: MCP_APPS_MIME_TYPE,
  resourceUri: 'ui://counter/app.html',
  serverId: 'counter',
  toolName: 'increment',
} as const;
const shell = {
  prepareShell: async () => ({ shellUrl: 'brainstrike-mcp-app://0/', token: '0'.repeat(32) }),
  readResource: async () => '<!doctype html>',
  releaseShell: async () => undefined,
};
const request = {
  arguments: { source: 'app' },
  origin,
  preparationId: 'preparation-1',
  threadId: 'thread-a',
  toolName: 'increment',
};

/** Core's answers: an asked decision, then a call that runs until it is cancelled. */
function hostClient() {
  const calls: { params: unknown; signal: AbortSignal | undefined }[] = [];
  const client = {
    request: async (method: string, params: unknown, signal?: AbortSignal) => {
      if (method === 'mcp/app/admit') {
        return { decision: 'ask', riskCategory: 'mcp' };
      }
      calls.push({ params, signal });
      return await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  } as unknown as HostClient;
  return { calls, client };
}

describe('hostMcpAppBridge', () => {
  it('sends an approved call to Core and cancels it there when the app releases it', async () => {
    const { calls, client } = hostClient();
    const bridge = hostMcpAppBridge(client, shell);
    await expect(bridge?.prepare(request)).resolves.toEqual({
      decision: 'ask',
      riskCategory: 'mcp',
    });
    const executing = bridge?.execute({ preparationId: 'preparation-1' });
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]?.params).toEqual({
      app: origin,
      approved: true,
      arguments: { source: 'app' },
      threadId: 'thread-a',
      toolName: 'increment',
    });
    await bridge?.release({ preparationId: 'preparation-1' });
    expect(calls[0]?.signal?.aborted).toBe(true);
    await expect(executing).rejects.toThrow('MCP App tool call released');
  });

  it('is null without the shell bridge', () => {
    expect(hostMcpAppBridge(hostClient().client, null)).toBeNull();
  });
});
