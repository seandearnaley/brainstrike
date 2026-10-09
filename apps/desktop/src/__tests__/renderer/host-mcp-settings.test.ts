import type { HostClient } from '@brainstrike/agent-host/browser';
import type { McpSettingsEvent } from '@brainstrike/agent-host/protocol';
import type { McpHostSnapshot } from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import { createDesktopHostMcpSettings } from '../../renderer/host-mcp-settings';

// The window's real connector loads the browser JSON-RPC transport; each test injects its host.
vi.mock('../../renderer/agent-host-client', () => ({ connectDesktopAgentHost: vi.fn() }));

const status = (revision: number): McpHostSnapshot => ({ revision, servers: [] });

/** The window's host client: one `mcp/settings/event` listener and the subscribe answer. */
function fakeHost() {
  let push: ((event: McpSettingsEvent) => void) | undefined;
  let answerSubscribe: (value: unknown) => void = () => undefined;
  const request = vi.fn((method: string) =>
    method === 'mcp/settings/subscribe'
      ? new Promise((resolve) => {
          answerSubscribe = resolve;
        })
      : Promise.resolve(status(9))
  );
  const host = {
    close: vi.fn(async () => undefined),
    onMcpSettings: vi.fn((listener: (event: McpSettingsEvent) => void) => {
      push = listener;
      return () => undefined;
    }),
    request,
  } as unknown as HostClient;
  return {
    answerSubscribe: (value: unknown) => answerSubscribe(value),
    host,
    push: (event: McpSettingsEvent) => push?.(event),
    request,
  };
}

describe('desktop host MCP settings (BST-1930 c5b)', () => {
  it('subscribes once and hands its listeners the status the stream started after', async () => {
    const fake = fakeHost();
    const settings = createDesktopHostMcpSettings(async () => fake.host);
    const first = vi.fn();
    const second = vi.fn();
    settings.subscribe(first);
    settings.subscribe(second);
    await vi.waitFor(() => expect(fake.request).toHaveBeenCalledWith('mcp/settings/subscribe', {}));

    fake.push({ status: status(4), type: 'status' });
    fake.answerSubscribe({
      config: { exists: false, path: '/profile/mcp/mcp.config.json' },
      extensions: { apps: true, tasks: true },
      status: status(3),
      tools: {},
    });

    await vi.waitFor(() =>
      expect(first.mock.calls).toEqual([
        [{ status: status(4), type: 'status' }],
        [{ status: status(3), type: 'status' }],
      ])
    );
    expect(second.mock.calls).toEqual(first.mock.calls);
    expect(
      fake.request.mock.calls.filter(([method]) => method === 'mcp/settings/subscribe')
    ).toHaveLength(1);
  });

  it('reads status and runs lifecycle control as host requests', async () => {
    const fake = fakeHost();
    const settings = createDesktopHostMcpSettings(async () => fake.host);

    await expect(settings.request('mcp/status/read', {})).resolves.toEqual(status(9));
    await settings.request('mcp/server/control', {
      action: 'disconnect',
      configuredServerId: 'fs' as never,
    });

    expect(fake.request.mock.calls).toEqual([
      ['mcp/status/read', {}],
      ['mcp/server/control', { action: 'disconnect', configuredServerId: 'fs' }],
    ]);
  });
});
