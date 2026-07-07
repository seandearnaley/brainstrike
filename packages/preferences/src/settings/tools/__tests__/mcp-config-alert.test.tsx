import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { McpConfigAlert } from '../mcp-config-alert';
import type { McpConfigInfo } from '../types';

// Mock @brainstrike/ui
vi.mock('@brainstrike/ui', () => ({
  Button: ({
    children,
    onClick,
    'data-testid': testId,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    'data-testid'?: string;
  }) => (
    <button data-testid={testId} onClick={onClick} type="button">
      {children}
    </button>
  ),
}));

describe('McpConfigAlert', () => {
  const defaultProps = {
    onResetConfig: vi.fn().mockResolvedValue(undefined),
    onSelectConfig: vi.fn().mockResolvedValue(undefined),
  };

  it('renders nothing when configInfo is null (loading state)', () => {
    const { container } = render(<McpConfigAlert {...defaultProps} configInfo={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when config exists', () => {
    const configInfo: McpConfigInfo = {
      exists: true,
      path: '/path/to/mcp.config.json',
    };
    const { container } = render(<McpConfigAlert {...defaultProps} configInfo={configInfo} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders warning when config is missing', () => {
    const configInfo: McpConfigInfo = {
      exists: false,
      path: '/path/to/mcp.config.json',
    };
    render(<McpConfigAlert {...defaultProps} configInfo={configInfo} />);

    expect(screen.getByTestId('mcp-config-alert')).toBeInTheDocument();
  });

  it('renders path inline with message', () => {
    const configInfo: McpConfigInfo = {
      exists: false,
      path: '/path/to/mcp.config.json',
    };
    render(<McpConfigAlert {...defaultProps} configInfo={configInfo} />);
    expect(screen.getByText(/MCP config not found/)).toBeInTheDocument();
  });

  it('displays the expected path', () => {
    const configInfo: McpConfigInfo = {
      exists: false,
      path: '/custom/path/mcp.config.json',
    };
    render(<McpConfigAlert {...defaultProps} configInfo={configInfo} />);

    expect(screen.getByText(/\/custom\/path\/mcp.config.json/)).toBeInTheDocument();
  });

  it('calls onSelectConfig when Select Config File button is clicked', async () => {
    const user = userEvent.setup();
    const onSelectConfig = vi.fn().mockResolvedValue(undefined);
    const configInfo: McpConfigInfo = {
      exists: false,
      path: '/path/to/mcp.config.json',
    };

    render(
      <McpConfigAlert
        configInfo={configInfo}
        onResetConfig={vi.fn()}
        onSelectConfig={onSelectConfig}
      />
    );

    await user.click(screen.getByTestId('select-config-btn'));
    expect(onSelectConfig).toHaveBeenCalledOnce();
  });

  it('calls onResetConfig when Reset to Default button is clicked', async () => {
    const user = userEvent.setup();
    const onResetConfig = vi.fn().mockResolvedValue(undefined);
    const configInfo: McpConfigInfo = {
      exists: false,
      path: '/path/to/mcp.config.json',
    };

    render(
      <McpConfigAlert
        configInfo={configInfo}
        onResetConfig={onResetConfig}
        onSelectConfig={vi.fn()}
      />
    );

    await user.click(screen.getByTestId('reset-config-btn'));
    expect(onResetConfig).toHaveBeenCalledOnce();
  });

  it('shows Create Sample Config button when onCreateSample is provided', () => {
    const configInfo: McpConfigInfo = {
      exists: false,
      path: '/path/to/mcp.config.json',
    };

    render(
      <McpConfigAlert
        {...defaultProps}
        configInfo={configInfo}
        onCreateSample={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByTestId('create-sample-btn')).toBeInTheDocument();
  });

  it('hides Create Sample Config button when onCreateSample is not provided', () => {
    const configInfo: McpConfigInfo = {
      exists: false,
      path: '/path/to/mcp.config.json',
    };

    render(<McpConfigAlert {...defaultProps} configInfo={configInfo} />);

    expect(screen.queryByTestId('create-sample-btn')).not.toBeInTheDocument();
  });

  it('calls onCreateSample when Create Sample Config button is clicked', async () => {
    const user = userEvent.setup();
    const onCreateSample = vi.fn().mockResolvedValue(undefined);
    const configInfo: McpConfigInfo = {
      exists: false,
      path: '/path/to/mcp.config.json',
    };

    render(
      <McpConfigAlert {...defaultProps} configInfo={configInfo} onCreateSample={onCreateSample} />
    );

    await user.click(screen.getByTestId('create-sample-btn'));
    expect(onCreateSample).toHaveBeenCalledOnce();
  });

  it('calls onDismiss when close button is clicked', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const configInfo: McpConfigInfo = {
      exists: false,
      path: '/path/to/mcp.config.json',
    };

    render(<McpConfigAlert {...defaultProps} configInfo={configInfo} onDismiss={onDismiss} />);

    const closeButton = screen.getByTestId('dismiss-alert');
    await user.click(closeButton);
    expect(onDismiss).toHaveBeenCalled();
  });

  it('does not show dismiss button when onDismiss is not provided', () => {
    const configInfo: McpConfigInfo = {
      exists: false,
      path: '/path/to/mcp.config.json',
    };

    render(<McpConfigAlert {...defaultProps} configInfo={configInfo} />);

    expect(screen.queryByTestId('dismiss-alert')).not.toBeInTheDocument();
  });
});
