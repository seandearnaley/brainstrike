import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpBanner } from '../mcp-banner';

interface McpConfig {
  error?: string;
  exists: boolean;
  path: string;
  servers?: Array<{ name: string; transport: 'stdio' | 'sse' }>;
}

type McpConfigResult = McpConfig | undefined;
type McpTools = Record<string, never[]>;

type McpWindow = Window & {
  mcp?: {
    getConfig?: () => Promise<McpConfigResult>;
    onToolsUpdated?: (callback: (tools: McpTools) => void) => (() => void) | undefined;
  };
};

function setMcpApi(mcp: NonNullable<McpWindow['mcp']>) {
  (window as unknown as McpWindow).mcp = mcp;
  return mcp;
}

function setMcpConfig(result: Promise<McpConfigResult>) {
  return setMcpApi({ getConfig: vi.fn(() => result) });
}

describe('McpBanner', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'mcp');
  });

  it('renders loaded state with server count', async () => {
    setMcpConfig(
      Promise.resolve({
        exists: true,
        path: '/Users/example/.brainstrike/mcp.json',
        servers: [{ name: 'local', transport: 'stdio' }],
      })
    );

    render(<McpBanner />);

    expect(await screen.findByText('loaded')).toBeInTheDocument();
    expect(screen.getByText('1 server')).toBeInTheDocument();
  });

  it('renders missing state without servers', async () => {
    setMcpConfig(
      Promise.resolve({ exists: false, path: '/Users/example/.brainstrike/mcp.json', servers: [] })
    );

    render(<McpBanner />);

    expect(await screen.findByText('missing')).toBeInTheDocument();
    expect(screen.queryByText(/server/)).not.toBeInTheDocument();
  });

  it('renders error state when config fetch fails', async () => {
    setMcpConfig(Promise.reject(new Error('boom')));

    render(<McpBanner />);

    await waitFor(() => {
      expect(screen.getByText('boom')).toBeInTheDocument();
    });
  });

  it('renders a destructive error instead of loaded when the config contains an error', async () => {
    setMcpConfig(
      Promise.resolve({
        error: 'invalid_mcp_config: duplicate property',
        exists: true,
        path: '/Users/example/.brainstrike/mcp.json',
      })
    );

    render(<McpBanner />);

    expect(await screen.findByText('error')).toHaveAttribute('data-variant', 'destructive');
    expect(screen.getByText('invalid_mcp_config: duplicate property')).toHaveClass(
      'text-destructive'
    );
    expect(screen.queryByText('loaded')).not.toBeInTheDocument();
  });

  it('refetches config on tool updates, replaces loaded state with errors, and unsubscribes', async () => {
    const unsubscribe = vi.fn();
    let notifyToolsUpdated: ((tools: McpTools) => void) | undefined;
    const getConfig = vi
      .fn<() => Promise<McpConfigResult>>()
      .mockResolvedValueOnce({
        exists: true,
        path: '/Users/example/.brainstrike/mcp.json',
        servers: [{ name: 'local', transport: 'stdio' }],
      })
      .mockResolvedValueOnce({
        error: 'invalid_mcp_config: malformed server',
        exists: true,
        path: '/Users/example/.brainstrike/mcp.json',
      });
    const onToolsUpdated = vi.fn((callback: (tools: McpTools) => void) => {
      notifyToolsUpdated = callback;
      return unsubscribe;
    });
    setMcpApi({ getConfig, onToolsUpdated });

    const { unmount } = render(<McpBanner />);

    expect(await screen.findByText('loaded')).toBeInTheDocument();
    expect(onToolsUpdated).toHaveBeenCalledTimes(1);

    act(() => notifyToolsUpdated?.({}));

    expect(await screen.findByText('invalid_mcp_config: malformed server')).toBeInTheDocument();
    expect(screen.queryByText('loaded')).not.toBeInTheDocument();
    expect(getConfig).toHaveBeenCalledTimes(2);

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
