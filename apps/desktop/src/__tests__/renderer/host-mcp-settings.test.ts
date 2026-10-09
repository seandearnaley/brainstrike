import type { HostClient } from '@brainstrike/agent-host/browser';
import type { McpPresentationEvent, McpSettingsEvent } from '@brainstrike/agent-host/protocol';
import type { McpHostSnapshot, McpTaskPresentation } from '@brainstrike/assistant-contract';
import { describe, expect, it, vi } from 'vitest';
import { connectDesktopAgentHost } from '../../renderer/agent-host-client';
import {
  createDesktopHostMcpSettings,
  resolveDesktopMcpContent,
} from '../../renderer/host-mcp-settings';

// The window's real connector loads the browser JSON-RPC transport; each test injects its host.
vi.mock('../../renderer/agent-host-client', () => ({ connectDesktopAgentHost: vi.fn() }));

const status = (revision: number): McpHostSnapshot => ({ revision, servers: [] });

const card = (taskId: string): McpTaskPresentation => ({
  canCancel: true,
  createdAt: '2026-10-09T00:00:00.000Z',
  handle: {
    authorityEpoch: '00000000-0000-7000-8000-000000000000',
    principalId: 'principal-a',
    resource: 'https://tasks.example.test',
    serverId: 'fs',
    taskId,
  },
  history: [{ at: '2026-10-09T00:00:00.000Z', status: 'working' }],
  omittedHistoryEntries: 0,
  recovery: 'live',
  status: 'working',
  statusMessage: null,
  updatedAt: '2026-10-09T00:00:00.000Z',
});

/** The window's host client: one listener per stream and each stream's subscribe answer. */
function fakeHost() {
  let push: ((event: McpSettingsEvent) => void) | undefined;
  let pushPresentation: ((event: McpPresentationEvent) => void) | undefined;
  let answerSubscribe: (value: unknown) => void = () => undefined;
  let answerPresentation: (value: unknown) => void = () => undefined;
  const request = vi.fn((method: string) => {
    if (method === 'mcp/settings/subscribe') {
      return new Promise((resolve) => {
        answerSubscribe = resolve;
      });
    }
    if (method === 'mcp/presentation/subscribe') {
      return new Promise((resolve) => {
        answerPresentation = resolve;
      });
    }
    return Promise.resolve(status(9));
  });
  const host = {
    close: vi.fn(async () => undefined),
    onMcpPresentation: vi.fn((listener: (event: McpPresentationEvent) => void) => {
      pushPresentation = listener;
      return () => undefined;
    }),
    onMcpSettings: vi.fn((listener: (event: McpSettingsEvent) => void) => {
      push = listener;
      return () => undefined;
    }),
    request,
  } as unknown as HostClient;
  return {
    answerPresentation: (value: unknown) => answerPresentation(value),
    answerSubscribe: (value: unknown) => answerSubscribe(value),
    host,
    push: (event: McpSettingsEvent) => push?.(event),
    pushPresentation: (event: McpPresentationEvent) => pushPresentation?.(event),
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

describe('desktop host MCP presentations (BST-1930 c5c)', () => {
  it('opens the presentation stream once, apart from settings, and replays its current cards', async () => {
    const fake = fakeHost();
    const settings = createDesktopHostMcpSettings(async () => fake.host);
    const first = vi.fn();
    const second = vi.fn();
    settings.subscribePresentation(first);
    settings.subscribePresentation(second);
    await vi.waitFor(() =>
      expect(fake.request).toHaveBeenCalledWith('mcp/presentation/subscribe', {})
    );

    fake.pushPresentation({
      code: 'mcp-elicitation-already-settled',
      id: 'p1',
      type: 'elicitation.retired',
    });
    fake.answerPresentation({ tasks: [card('a')] });

    await vi.waitFor(() =>
      expect(first.mock.calls).toEqual([
        [{ code: 'mcp-elicitation-already-settled', id: 'p1', type: 'elicitation.retired' }],
        [{ task: card('a'), type: 'task' }],
      ])
    );
    expect(second.mock.calls).toEqual(first.mock.calls);
    expect(fake.request.mock.calls.map(([method]) => method)).toEqual([
      'mcp/presentation/subscribe',
    ]);
  });

  it('runs task actions and answers server input as host requests', async () => {
    const fake = fakeHost();
    const settings = createDesktopHostMcpSettings(async () => fake.host);
    const handle = card('a').handle;
    const settlement = {
      action: 'decline' as const,
      configuredServerId: 'fs' as never,
      generation: 2,
      id: 'p1',
      requestId: 'r1',
    };

    await settings.request('mcp/tasks/act', { action: 'cancel', handle });
    await settings.request('mcp/tasks/list', {});
    await settings.request('mcp/elicitation/settle', settlement);

    expect(fake.request.mock.calls).toEqual([
      ['mcp/tasks/act', { action: 'cancel', handle }],
      ['mcp/tasks/list', {}],
      ['mcp/elicitation/settle', settlement],
    ]);
  });
});

describe('desktop host MCP content (BST-1930 c5d)', () => {
  it("returns a verb's result, and turns a refusal into an Error carrying only the taxonomy", async () => {
    const request = vi.fn(async (method: string) =>
      method === 'mcp/content/read'
        ? { ok: true, result: { result: { contents: [] }, type: 'resources/read' } }
        : {
            error: {
              category: 'generation-retired',
              code: 'mcp_content_generation_retired',
              message: 'MCP content generation retired',
            },
            ok: false,
          }
    );
    vi.mocked(connectDesktopAgentHost).mockResolvedValue({
      close: vi.fn(async () => undefined),
      onMcpPresentation: vi.fn(() => () => undefined),
      onMcpSettings: vi.fn(() => () => undefined),
      request,
    } as unknown as HostClient);
    Object.assign(window, { agentHost: { connect: vi.fn() } });
    const content = resolveDesktopMcpContent();
    const authority = { configuredServerId: 'fs', generation: 2 };

    await expect(content?.readResource({ authority, uri: 'ui://x' })).resolves.toEqual({
      result: { contents: [] },
      type: 'resources/read',
    });
    await expect(content?.getPrompt({ authority, name: 'review' })).rejects.toMatchObject({
      category: 'generation-retired',
      code: 'mcp_content_generation_retired',
      message:
        'MCP content generation retired (generation-retired · mcp_content_generation_retired)',
    });
    expect(request.mock.calls).toEqual([
      ['mcp/content/read', { authority, uri: 'ui://x' }],
      ['mcp/content/prompt', { authority, name: 'review' }],
    ]);
  });
});
