/**
 * Tool Group Accordion Tests
 *
 * Tests for the accordion wrapper component that handles tool group display.
 */

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpConnectionStatus } from '../tool-group-accordion';
import { ToolGroupAccordion } from '../tool-group-accordion';

// Mock @brainstrike/ui - Accordion components
vi.mock('@brainstrike/ui', () => ({
  AccordionContent: ({
    children,
    'data-testid': testId,
  }: {
    children: React.ReactNode;
    'data-testid'?: string;
  }) => <div data-testid={testId}>{children}</div>,
  AccordionItem: ({
    children,
    value,
    'data-testid': testId,
  }: {
    children: React.ReactNode;
    value: string;
    'data-testid'?: string;
  }) => (
    <div data-testid={testId} data-value={value}>
      {children}
    </div>
  ),
  AccordionTrigger: ({
    children,
    className,
    'data-testid': testId,
  }: {
    children: React.ReactNode;
    className?: string;
    'data-testid'?: string;
  }) => (
    <button className={className} data-testid={testId} type="button">
      {children}
    </button>
  ),
  Badge: ({ children, variant }: { children: React.ReactNode; variant?: string }) => (
    <span data-testid="badge" data-variant={variant}>
      {children}
    </span>
  ),
  Button: ({
    children,
    onClick,
    variant,
    size,
    'data-testid': testId,
    className,
  }: {
    children: React.ReactNode;
    onClick?: (e: React.MouseEvent) => void;
    variant?: string;
    size?: string;
    'data-testid'?: string;
    className?: string;
  }) => (
    <button
      className={className}
      data-size={size}
      data-testid={testId}
      data-variant={variant}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  ),
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-menu">{children}</div>
  ),
  DropdownMenuContent: ({ children, align }: { children: React.ReactNode; align?: string }) => (
    <div data-align={align} data-testid="dropdown-menu-content">
      {children}
    </div>
  ),
  DropdownMenuItem: ({
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
  DropdownMenuSeparator: () => <hr data-testid="dropdown-separator" />,
  DropdownMenuTrigger: ({
    children,
    asChild,
  }: {
    children: React.ReactNode;
    asChild?: boolean;
  }) => (
    <div data-as-child={asChild} data-testid="dropdown-menu-trigger">
      {children}
    </div>
  ),
}));

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  Circle: ({ className }: { className?: string }) => (
    <span className={className} data-testid="status-indicator" />
  ),
  MoreVertical: () => <span data-testid="more-icon" />,
  RefreshCw: () => <span data-testid="refresh-icon" />,
  Settings: () => <span data-testid="settings-icon" />,
}));

describe('ToolGroupAccordion', () => {
  const defaultProps = {
    description: 'Built-in BrainStrike tools',
    enabledCount: 8,
    id: 'native-tools',
    label: 'Native Tools',
    onDisableAll: vi.fn(),
    onEnableAll: vi.fn(),
    source: 'native' as const,
    totalCount: 12,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('renders the group label', () => {
      render(
        <ToolGroupAccordion {...defaultProps}>
          <div>Tool content</div>
        </ToolGroupAccordion>
      );

      expect(screen.getByText('Native Tools')).toBeInTheDocument();
    });

    it('renders the description', () => {
      render(
        <ToolGroupAccordion {...defaultProps}>
          <div>Tool content</div>
        </ToolGroupAccordion>
      );

      expect(screen.getByText('Built-in BrainStrike tools')).toBeInTheDocument();
    });

    it('renders enabled count fraction as badge', () => {
      render(
        <ToolGroupAccordion {...defaultProps}>
          <div>Tool content</div>
        </ToolGroupAccordion>
      );

      expect(screen.getByText('8/12 enabled')).toBeInTheDocument();
    });

    it('renders children in accordion content', () => {
      render(
        <ToolGroupAccordion {...defaultProps}>
          <div data-testid="child-content">Tool content</div>
        </ToolGroupAccordion>
      );

      expect(screen.getByTestId('child-content')).toBeInTheDocument();
    });

    it('uses id as accordion value', () => {
      render(
        <ToolGroupAccordion {...defaultProps}>
          <div>Tool content</div>
        </ToolGroupAccordion>
      );

      const item = screen.getByTestId('tool-group-native-tools');
      expect(item).toHaveAttribute('data-value', 'native-tools');
    });
  });

  describe('MCP connection status', () => {
    it('shows connected status for MCP groups', () => {
      const mcpProps = {
        ...defaultProps,
        connectionStatus: 'connected' as McpConnectionStatus,
        id: 'mcp-github',
        label: 'GitHub MCP',
        source: 'mcp' as const,
      };

      render(
        <ToolGroupAccordion {...mcpProps}>
          <div>Tool content</div>
        </ToolGroupAccordion>
      );

      const indicators = screen.getAllByTestId('status-indicator');
      // Should have green indicator for connected status
      expect(indicators[0]).toHaveClass('fill-green-500');
    });

    it('shows connecting status for MCP groups', () => {
      const mcpProps = {
        ...defaultProps,
        connectionStatus: 'connecting' as McpConnectionStatus,
        id: 'mcp-github',
        label: 'GitHub MCP',
        source: 'mcp' as const,
      };

      render(
        <ToolGroupAccordion {...mcpProps}>
          <div>Tool content</div>
        </ToolGroupAccordion>
      );

      const indicators = screen.getAllByTestId('status-indicator');
      // Should have yellow/amber indicator for connecting status
      expect(indicators[0]).toHaveClass('fill-yellow-500');
    });

    it('shows disconnected status for MCP groups', () => {
      const mcpProps = {
        ...defaultProps,
        connectionStatus: 'disconnected' as McpConnectionStatus,
        id: 'mcp-github',
        label: 'GitHub MCP',
        source: 'mcp' as const,
      };

      render(
        <ToolGroupAccordion {...mcpProps}>
          <div>Tool content</div>
        </ToolGroupAccordion>
      );

      const indicators = screen.getAllByTestId('status-indicator');
      // Should have muted indicator for disconnected status
      expect(indicators[0]).toHaveClass('fill-muted-foreground');
    });

    it('shows error status with message for MCP groups', () => {
      const mcpProps = {
        ...defaultProps,
        connectionStatus: 'error' as McpConnectionStatus,
        errorMessage: 'Connection failed',
        id: 'mcp-github',
        label: 'GitHub MCP',
        source: 'mcp' as const,
      };

      render(
        <ToolGroupAccordion {...mcpProps}>
          <div>Tool content</div>
        </ToolGroupAccordion>
      );

      const indicators = screen.getAllByTestId('status-indicator');
      // Should have red/destructive indicator for error status
      expect(indicators[0]).toHaveClass('fill-destructive');
      expect(screen.getByText('Connection failed')).toBeInTheDocument();
    });

    it('does not show connection status for native groups', () => {
      render(
        <ToolGroupAccordion {...defaultProps}>
          <div>Tool content</div>
        </ToolGroupAccordion>
      );

      // Native tools should not have status indicator
      expect(screen.queryByTestId('status-indicator')).not.toBeInTheDocument();
    });
  });

  describe('dropdown menu actions', () => {
    it('calls onEnableAll when Enable All is clicked', () => {
      render(
        <ToolGroupAccordion {...defaultProps}>
          <div>Tool content</div>
        </ToolGroupAccordion>
      );

      const enableAllButton = screen.getByTestId('enable-all-action');
      fireEvent.click(enableAllButton);

      expect(defaultProps.onEnableAll).toHaveBeenCalledTimes(1);
    });

    it('calls onDisableAll when Disable All is clicked', () => {
      render(
        <ToolGroupAccordion {...defaultProps}>
          <div>Tool content</div>
        </ToolGroupAccordion>
      );

      const disableAllButton = screen.getByTestId('disable-all-action');
      fireEvent.click(disableAllButton);

      expect(defaultProps.onDisableAll).toHaveBeenCalledTimes(1);
    });

    it('shows Refresh Connection option for MCP groups', () => {
      const mcpProps = {
        ...defaultProps,
        connectionStatus: 'connected' as McpConnectionStatus,
        id: 'mcp-github',
        label: 'GitHub MCP',
        onRefreshConnection: vi.fn(),
        source: 'mcp' as const,
      };

      render(
        <ToolGroupAccordion {...mcpProps}>
          <div>Tool content</div>
        </ToolGroupAccordion>
      );

      expect(screen.getByTestId('refresh-connection-action')).toBeInTheDocument();
    });

    it('calls onRefreshConnection when Refresh Connection is clicked', () => {
      const onRefreshConnection = vi.fn();
      const mcpProps = {
        ...defaultProps,
        connectionStatus: 'connected' as McpConnectionStatus,
        id: 'mcp-github',
        label: 'GitHub MCP',
        onRefreshConnection,
        source: 'mcp' as const,
      };

      render(
        <ToolGroupAccordion {...mcpProps}>
          <div>Tool content</div>
        </ToolGroupAccordion>
      );

      const refreshButton = screen.getByTestId('refresh-connection-action');
      fireEvent.click(refreshButton);

      expect(onRefreshConnection).toHaveBeenCalledTimes(1);
    });

    it('shows Open Config File option for MCP groups', () => {
      const mcpProps = {
        ...defaultProps,
        connectionStatus: 'connected' as McpConnectionStatus,
        id: 'mcp-github',
        label: 'GitHub MCP',
        onOpenConfigFile: vi.fn(),
        source: 'mcp' as const,
      };

      render(
        <ToolGroupAccordion {...mcpProps}>
          <div>Tool content</div>
        </ToolGroupAccordion>
      );

      expect(screen.getByTestId('open-config-action')).toBeInTheDocument();
    });

    it('calls onOpenConfigFile when Open Config File is clicked', () => {
      const onOpenConfigFile = vi.fn();
      const mcpProps = {
        ...defaultProps,
        connectionStatus: 'connected' as McpConnectionStatus,
        id: 'mcp-github',
        label: 'GitHub MCP',
        onOpenConfigFile,
        source: 'mcp' as const,
      };

      render(
        <ToolGroupAccordion {...mcpProps}>
          <div>Tool content</div>
        </ToolGroupAccordion>
      );

      const configButton = screen.getByTestId('open-config-action');
      fireEvent.click(configButton);

      expect(onOpenConfigFile).toHaveBeenCalledTimes(1);
    });

    it('does not show MCP-specific options for native groups', () => {
      render(
        <ToolGroupAccordion {...defaultProps}>
          <div>Tool content</div>
        </ToolGroupAccordion>
      );

      expect(screen.queryByTestId('refresh-connection-action')).not.toBeInTheDocument();
      expect(screen.queryByTestId('open-config-action')).not.toBeInTheDocument();
    });
  });

  describe('badge styling', () => {
    it('shows secondary variant badge for partial enablement', () => {
      render(
        <ToolGroupAccordion {...defaultProps}>
          <div>Tool content</div>
        </ToolGroupAccordion>
      );

      const badge = screen.getByText('8/12 enabled').closest('[data-testid="badge"]');
      expect(badge).toHaveAttribute('data-variant', 'secondary');
    });

    it('shows outline variant badge when all tools are disabled', () => {
      const props = {
        ...defaultProps,
        enabledCount: 0,
      };

      render(
        <ToolGroupAccordion {...props}>
          <div>Tool content</div>
        </ToolGroupAccordion>
      );

      const badge = screen.getByText('0/12 enabled').closest('[data-testid="badge"]');
      expect(badge).toHaveAttribute('data-variant', 'outline');
    });

    it('shows default variant badge when all tools are enabled', () => {
      const props = {
        ...defaultProps,
        enabledCount: 12,
        totalCount: 12,
      };

      render(
        <ToolGroupAccordion {...props}>
          <div>Tool content</div>
        </ToolGroupAccordion>
      );

      const badge = screen.getByText('12/12 enabled').closest('[data-testid="badge"]');
      expect(badge).toHaveAttribute('data-variant', 'default');
    });
  });
});
