import '@testing-library/jest-dom/vitest';
import type { HubSnapshot } from '@brainstrike/agent-hub';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentHubPanel } from '../agent-hub-panel';

const snapshot: HubSnapshot = {
  agents: [
    {
      agentId: 'builtin-id',
      builtin: true,
      capabilities: [],
      color: 'chart-5',
      joinedAt: 1000,
      lastSeenAt: 1000,
      name: 'brainstrike',
      sessionKey: 'builtin',
      status: 'online',
      tokensReceived: 0,
      tokensSent: 12,
    },
    {
      agentId: 'alpha-id',
      builtin: false,
      capabilities: ['code'],
      color: 'chart-1',
      joinedAt: 2000,
      lastSeenAt: 3000,
      name: 'alpha',
      program: 'claude-code',
      sessionKey: 's1',
      status: 'online',
      tokensReceived: 2500,
      tokensSent: 100,
      worktree: '/tmp/wt-alpha',
    },
  ],
  channels: ['#general'],
  recentMessages: [
    {
      channel: '#general',
      fromAgentId: 'alpha-id',
      fromColor: 'chart-1',
      fromName: 'alpha',
      id: 1,
      mentions: [],
      postedAt: 2500,
      text: 'hello room',
      tokenCount: 3,
    },
  ],
  totalMessages: 1,
  totalTokens: 3,
};

const runningStatus = {
  connectionCount: 1,
  error: null,
  state: 'running' as const,
  url: 'http://127.0.0.1:4519/mcp',
};

function installBridge(overrides?: Record<string, unknown>) {
  const bridge = {
    applyConfig: vi.fn(),
    getSnapshot: vi.fn().mockResolvedValue(snapshot),
    getStatus: vi.fn().mockResolvedValue(runningStatus),
    onSnapshot: vi.fn(() => () => {}),
    onStatus: vi.fn(() => () => {}),
    postMessage: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(),
    stop: vi.fn(),
    ...overrides,
  };
  (window as unknown as { agentHub: typeof bridge }).agentHub = bridge;
  return bridge;
}

function removeBridge() {
  Reflect.deleteProperty(window as Window & { agentHub?: unknown }, 'agentHub');
}

describe('AgentHubPanel', () => {
  beforeEach(() => {
    removeBridge();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    removeBridge();
  });

  it('renders a desktop-only empty state without the bridge', () => {
    render(<AgentHubPanel />);
    expect(screen.getByText(/desktop app/i)).toBeInTheDocument();
  });

  it('renders color-coded agent cards with token usage', async () => {
    installBridge();
    render(<AgentHubPanel />);
    const alphaMatches = await screen.findAllByText('alpha');
    expect(alphaMatches.length).toBeGreaterThan(0);
    expect(screen.getByText('brainstrike')).toBeInTheDocument();
    expect(screen.getByText(/claude-code/)).toBeInTheDocument();
    const alphaCard = screen.getByTestId('agent-card-alpha-id');
    expect(alphaCard.querySelector('[data-agent-color="chart-1"]')).not.toBeNull();
    expect(screen.getByText(/2\.5K tokens/)).toBeInTheDocument();
  });

  it('renders chat messages with author chips and a token badge', async () => {
    installBridge();
    render(<AgentHubPanel />);
    expect(await screen.findByText('hello room')).toBeInTheDocument();
    const message = screen.getByTestId('hub-message-1');
    expect(message).toHaveTextContent('alpha');
    expect(message).toHaveTextContent('3 tokens');
  });

  it('sends composer text through the bridge and clears the input', async () => {
    const bridge = installBridge();
    const user = userEvent.setup();
    render(<AgentHubPanel />);
    await screen.findByText('hello room');
    const input = screen.getByPlaceholderText(/message #general/i);
    await user.type(input, 'hi agents');
    await user.keyboard('{Enter}');
    expect(bridge.postMessage).toHaveBeenCalledWith({ channel: '#general', text: 'hi agents' });
    expect(input).toHaveValue('');
  });

  it('shows a stopped callout when the server is not running', async () => {
    installBridge({
      getStatus: vi
        .fn()
        .mockResolvedValue({ connectionCount: 0, error: null, state: 'stopped', url: null }),
    });
    render(<AgentHubPanel />);
    expect(await screen.findByText(/not running/i)).toBeInTheDocument();
    expect(screen.getByText(/settings/i)).toBeInTheDocument();
  });

  it('updates when a snapshot event arrives', async () => {
    const holder: { push: ((next: HubSnapshot) => void) | null } = { push: null };
    installBridge({
      onSnapshot: vi.fn((cb: (next: HubSnapshot) => void) => {
        holder.push = cb;
        return () => {};
      }),
    });
    render(<AgentHubPanel />);
    await screen.findByText('hello room');
    holder.push?.({
      ...snapshot,
      recentMessages: [
        ...snapshot.recentMessages,
        {
          channel: '#general',
          fromAgentId: 'builtin-id',
          fromColor: 'chart-5',
          fromName: 'brainstrike',
          id: 2,
          mentions: [],
          postedAt: 4000,
          text: 'welcome alpha',
          tokenCount: 4,
        },
      ],
      totalMessages: 2,
    });
    expect(await screen.findByText('welcome alpha')).toBeInTheDocument();
  });
});
