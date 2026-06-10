import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentHubSettingsSection, createAgentHubSettingsCategory } from '../settings/agent-hub';
import { useAgentHubPreferencesStore } from '../stores/agent-hub-preferences-store';

interface MockAgentHubBridge {
  applyConfig: ReturnType<typeof vi.fn>;
  getSnapshot: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
  onSnapshot: ReturnType<typeof vi.fn>;
  onStatus: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

const stoppedStatus = { connectionCount: 0, error: null, state: 'stopped', url: null };
const runningStatus = {
  connectionCount: 2,
  error: null,
  state: 'running',
  url: 'http://127.0.0.1:4519/mcp',
};

function installAgentHubBridge(overrides?: Partial<MockAgentHubBridge>): MockAgentHubBridge {
  const bridge: MockAgentHubBridge = {
    applyConfig: vi.fn().mockResolvedValue(runningStatus),
    getSnapshot: vi.fn().mockResolvedValue({ agents: [], recentMessages: [] }),
    getStatus: vi.fn().mockResolvedValue(stoppedStatus),
    onSnapshot: vi.fn(() => () => {}),
    onStatus: vi.fn(() => () => {}),
    postMessage: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(runningStatus),
    stop: vi.fn().mockResolvedValue(stoppedStatus),
    ...overrides,
  };
  (window as unknown as { agentHub: MockAgentHubBridge }).agentHub = bridge;
  return bridge;
}

function removeAgentHubBridge() {
  Reflect.deleteProperty(window as Window & { agentHub?: unknown }, 'agentHub');
}

describe('AgentHubSettingsSection', () => {
  beforeEach(() => {
    localStorage.clear();
    useAgentHubPreferencesStore.setState({
      authToken: null,
      bindAddress: '127.0.0.1',
      enabled: false,
      maxMessagesPerChannel: 1000,
      port: 4519,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    removeAgentHubBridge();
  });

  it('renders a desktop-only notice when the bridge is unavailable', () => {
    render(<AgentHubSettingsSection available={false} />);
    expect(screen.getByText(/desktop app/i)).toBeInTheDocument();
  });

  it('renders defaults from the preferences store', async () => {
    installAgentHubBridge();
    render(<AgentHubSettingsSection available={true} />);
    expect(await screen.findByLabelText(/port/i)).toHaveValue(4519);
    expect(screen.getByRole('switch', { name: /enable agent hub/i })).not.toBeChecked();
  });

  it('enabling the hub applies the runtime config through the bridge', async () => {
    const bridge = installAgentHubBridge();
    const user = userEvent.setup();
    render(<AgentHubSettingsSection available={true} />);
    await user.click(screen.getByRole('switch', { name: /enable agent hub/i }));
    await waitFor(() => {
      expect(bridge.applyConfig).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true, port: 4519 })
      );
    });
    expect(useAgentHubPreferencesStore.getState().enabled).toBe(true);
  });

  it('shows the running URL and connection count from status updates', async () => {
    installAgentHubBridge({ getStatus: vi.fn().mockResolvedValue(runningStatus) });
    render(<AgentHubSettingsSection available={true} />);
    const urls = await screen.findAllByText(/http:\/\/127\.0\.0\.1:4519\/mcp/);
    expect(urls.length).toBeGreaterThan(0);
    expect(screen.getByText(/2 connected/i)).toBeInTheDocument();
  });

  it('surfaces applyConfig failures inline', async () => {
    installAgentHubBridge({
      applyConfig: vi.fn().mockRejectedValue(new Error('port must be 0 (ephemeral) or...')),
    });
    const user = userEvent.setup();
    render(<AgentHubSettingsSection available={true} />);
    await user.click(screen.getByRole('switch', { name: /enable agent hub/i }));
    expect(await screen.findByText(/port must be/i)).toBeInTheDocument();
  });
});

describe('createAgentHubSettingsCategory', () => {
  it('returns a category with stable id and metadata', () => {
    const category = createAgentHubSettingsCategory({ available: true });
    expect(category.id).toBe('agent-hub');
    expect(category.title).toBe('Agent Hub');
    expect(category.keywords).toEqual(expect.arrayContaining(['mcp', 'agents']));
  });
});
