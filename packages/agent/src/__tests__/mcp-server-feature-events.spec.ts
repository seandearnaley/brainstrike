import type { Client } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { McpServerFeatureEventRegistry } from '../mcp/server-feature-events';

describe('MCP server feature events', () => {
  it('settles every subscriber and reports every rejection through the diagnostic sink', async () => {
    const handlers = new Map<string, (notification: unknown) => Promise<void>>();
    const client = {
      setNotificationHandler: (method: string, handler: (notification: unknown) => Promise<void>) =>
        handlers.set(method, handler),
    } as unknown as Client;
    const firstFailure = new Error('first subscriber failed');
    const secondFailure = new Error('second subscriber failed');
    const onDiagnostic = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new Error('diagnostic sink failed'));
    const successfulSubscriber = vi.fn();
    const registry = new McpServerFeatureEventRegistry(onDiagnostic);
    registry.subscribe({ onToolListChanged: async () => await Promise.reject(firstFailure) });
    registry.subscribe({
      onToolListChanged: () => {
        throw secondFailure;
      },
    });
    registry.subscribe({ onToolListChanged: successfulSubscriber });
    registry.install(client);

    const handler = handlers.get('notifications/tools/list_changed');
    await expect(
      handler?.({ method: 'notifications/tools/list_changed' })
    ).resolves.toBeUndefined();

    expect(successfulSubscriber).toHaveBeenCalledOnce();
    expect(onDiagnostic).toHaveBeenNthCalledWith(1, 'tool-list-changed', firstFailure);
    expect(onDiagnostic).toHaveBeenNthCalledWith(2, 'tool-list-changed', secondFailure);
  });
});
