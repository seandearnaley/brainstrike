/**
 * MCP Server Status Tests
 */

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServerStatus } from '../mcp-server-status';
import type { McpServerInfo } from '../types';

// Mock @brainstrike/ui
vi.mock('@brainstrike/ui', () => ({
  Card: ({
    children,
    'data-testid': testId,
  }: {
    children: React.ReactNode;
    'data-testid'?: string;
  }) => <div data-testid={testId}>{children}</div>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Button: ({
    children,
    onClick,
    disabled,
    'data-testid': testId,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    'data-testid'?: string;
  }) => (
    <button data-testid={testId} disabled={disabled} onClick={onClick} type="button">
      {children}
    </button>
  ),
}));

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  Circle: ({ className }: { className?: string }) => (
    <span className={className} data-testid="status-indicator" />
  ),
  RefreshCw: ({ className }: { className?: string }) => (
    <span className={className} data-testid="refresh-icon" />
  ),
  Settings: () => <span data-testid="settings-icon" />,
}));

describe('McpServerStatus', () => {
  const mockOnRefresh = vi.fn();
  const mockOnOpenConfig = vi.fn();
  const mockOnEnableServer = vi.fn();
  const mockOnDisableServer = vi.fn();

  const connectedServer: McpServerInfo = {
    name: 'github',
    status: 'connected',
    toolCount: 15,
  };

  const disconnectedServer: McpServerInfo = {
    name: 'slack',
    status: 'disconnected',
    toolCount: 0,
  };

  const errorServer: McpServerInfo = {
    name: 'broken',
    status: 'error',
    toolCount: 0,
    error: 'Connection failed',
  };

  const defaultProps = {
    servers: [connectedServer],
    onRefresh: mockOnRefresh,
    onEnableServer: mockOnEnableServer,
    onDisableServer: mockOnDisableServer,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('renders nothing when servers array is empty', () => {
      const { container } = render(
        <McpServerStatus
          onDisableServer={mockOnDisableServer}
          onEnableServer={mockOnEnableServer}
          onRefresh={mockOnRefresh}
          servers={[]}
        />
      );

      expect(container.firstChild).toBeNull();
    });

    it('renders the component with servers', () => {
      render(<McpServerStatus {...defaultProps} />);

      expect(screen.getByTestId('mcp-server-status')).toBeInTheDocument();
      expect(screen.getByText('MCP Servers')).toBeInTheDocument();
    });

    it('renders server name and tool count', () => {
      render(<McpServerStatus {...defaultProps} />);

      expect(screen.getByText('github')).toBeInTheDocument();
      expect(screen.getByText('15 tools')).toBeInTheDocument();
    });

    it('renders multiple servers', () => {
      render(
        <McpServerStatus
          {...defaultProps}
          servers={[connectedServer, disconnectedServer, errorServer]}
        />
      );

      expect(screen.getByTestId('server-github')).toBeInTheDocument();
      expect(screen.getByTestId('server-slack')).toBeInTheDocument();
      expect(screen.getByTestId('server-broken')).toBeInTheDocument();
    });
  });

  describe('refresh functionality', () => {
    it('renders refresh button', () => {
      render(<McpServerStatus {...defaultProps} />);

      expect(screen.getByTestId('refresh-mcp')).toBeInTheDocument();
    });

    it('calls onRefresh when refresh button is clicked', () => {
      render(<McpServerStatus {...defaultProps} />);

      fireEvent.click(screen.getByTestId('refresh-mcp'));

      expect(mockOnRefresh).toHaveBeenCalledTimes(1);
    });

    it('disables refresh button when loading', () => {
      render(<McpServerStatus {...defaultProps} loading={true} />);

      expect(screen.getByTestId('refresh-mcp')).toBeDisabled();
    });

    it('shows spinning icon when loading', () => {
      render(<McpServerStatus {...defaultProps} loading={true} />);

      const icon = screen.getByTestId('refresh-icon');
      expect(icon.className).toContain('animate-spin');
    });
  });

  describe('config button', () => {
    it('renders config button when onOpenConfig is provided', () => {
      render(<McpServerStatus {...defaultProps} onOpenConfig={mockOnOpenConfig} />);

      expect(screen.getByTestId('open-config')).toBeInTheDocument();
    });

    it('does not render config button when onOpenConfig is not provided', () => {
      render(<McpServerStatus {...defaultProps} />);

      expect(screen.queryByTestId('open-config')).not.toBeInTheDocument();
    });

    it('calls onOpenConfig when config button is clicked', () => {
      render(<McpServerStatus {...defaultProps} onOpenConfig={mockOnOpenConfig} />);

      fireEvent.click(screen.getByTestId('open-config'));

      expect(mockOnOpenConfig).toHaveBeenCalledTimes(1);
    });
  });

  describe('server controls', () => {
    it('renders enable all button for each server', () => {
      render(<McpServerStatus {...defaultProps} />);

      expect(screen.getByText('Enable All')).toBeInTheDocument();
    });

    it('renders disable all button for each server', () => {
      render(<McpServerStatus {...defaultProps} />);

      expect(screen.getByText('Disable All')).toBeInTheDocument();
    });

    it('calls onEnableServer with server name when Enable All is clicked', () => {
      render(<McpServerStatus {...defaultProps} />);

      fireEvent.click(screen.getByText('Enable All'));

      expect(mockOnEnableServer).toHaveBeenCalledWith('github');
    });

    it('calls onDisableServer with server name when Disable All is clicked', () => {
      render(<McpServerStatus {...defaultProps} />);

      fireEvent.click(screen.getByText('Disable All'));

      expect(mockOnDisableServer).toHaveBeenCalledWith('github');
    });
  });

  describe('status indicators', () => {
    it('shows connected status indicator for connected server', () => {
      render(<McpServerStatus {...defaultProps} servers={[connectedServer]} />);

      const indicators = screen.getAllByTestId('status-indicator');
      expect(indicators[0]?.className).toContain('fill-green-500');
    });

    it('shows disconnected status indicator for disconnected server', () => {
      render(<McpServerStatus {...defaultProps} servers={[disconnectedServer]} />);

      const indicators = screen.getAllByTestId('status-indicator');
      expect(indicators[0]?.className).toContain('fill-muted-foreground');
    });

    it('shows error status indicator for error server', () => {
      render(<McpServerStatus {...defaultProps} servers={[errorServer]} />);

      const indicators = screen.getAllByTestId('status-indicator');
      expect(indicators[0]?.className).toContain('fill-destructive');
    });
  });
});
