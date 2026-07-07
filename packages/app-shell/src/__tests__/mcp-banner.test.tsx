import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { McpBanner } from '../mcp-banner';

interface McpConfig {
  exists: boolean;
  path: string;
  servers?: Array<{ name: string; transport: 'stdio' | 'sse' }>;
}

type McpConfigResult = McpConfig | undefined;

type McpWindow = Window & {
  mcp?: {
    getConfig?: () => Promise<McpConfigResult>;
  };
};

function setMcpConfig(result: Promise<McpConfigResult>) {
  const mcp = { getConfig: vi.fn(() => result) };
  (window as unknown as McpWindow).mcp = mcp;
  return mcp;
}

describe('McpBanner', () => {
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
});
