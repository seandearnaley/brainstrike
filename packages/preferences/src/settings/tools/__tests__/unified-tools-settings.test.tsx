/**
 * Unified Tools Settings Tests
 */

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolDisplayMetadata, ToolStats, ToolsSettingsOperations } from '../types';
import { UnifiedToolsSettings } from '../unified-tools-settings';

// Mock child components
vi.mock('../token-budget-summary', () => ({
  TokenBudgetSummary: () => <div data-testid="token-budget-summary">Budget Summary</div>,
}));

vi.mock('../mcp-config-alert', () => ({
  McpConfigAlert: ({ onDismiss }: { onDismiss?: () => void }) => (
    <div data-testid="mcp-config-alert">
      MCP Config Alert
      {onDismiss && (
        <button data-testid="dismiss-alert" onClick={onDismiss} type="button">
          Dismiss
        </button>
      )}
    </div>
  ),
}));

vi.mock('../tools-filter-bar', () => ({
  ToolsFilterBar: ({
    onSearchChange,
    onReset,
    totalCount,
  }: {
    onSearchChange: (q: string) => void;
    onReset: () => void;
    totalCount?: number;
  }) => (
    <div data-testid="tools-filter-bar">
      <input
        data-testid="search-input"
        onChange={(e) => onSearchChange(e.target.value)}
        type="text"
      />
      <button data-testid="reset-button" onClick={onReset} type="button">
        Reset
      </button>
      {totalCount !== undefined && <span data-testid="total-count">{totalCount} tools</span>}
    </div>
  ),
}));

vi.mock('../tool-group-accordion', () => ({
  ToolGroupAccordion: ({
    id,
    label,
    enabledCount,
    totalCount,
    onEnableAll,
    onDisableAll,
    children,
    connectionStatus,
  }: {
    id: string;
    label: string;
    enabledCount: number;
    totalCount: number;
    onEnableAll: () => void;
    onDisableAll: () => void;
    children: React.ReactNode;
    connectionStatus?: string;
  }) => (
    <div data-testid={`tool-group-${id}`}>
      <div data-testid={`group-header-${id}`}>
        <span>{label}</span>
        <span data-testid={`enabled-count-${id}`}>
          {enabledCount}/{totalCount}
        </span>
        {connectionStatus && (
          <span data-testid={`connection-status-${id}`}>{connectionStatus}</span>
        )}
        <button data-testid={`enable-all-${id}`} onClick={onEnableAll} type="button">
          Enable All
        </button>
        <button data-testid={`disable-all-${id}`} onClick={onDisableAll} type="button">
          Disable All
        </button>
      </div>
      <div data-testid={`group-content-${id}`}>{children}</div>
    </div>
  ),
}));

vi.mock('../tool-row', () => ({
  ToolRow: ({
    tool,
    onToggle,
    onExpand,
    expanded,
  }: {
    tool: ToolDisplayMetadata;
    onToggle: (id: string, enabled: boolean) => Promise<void>;
    onExpand?: (id: string) => void;
    expanded?: boolean;
  }) => (
    <div data-expanded={expanded} data-testid={`tool-row-${tool.id}`}>
      <span>{tool.id}</span>
      <button
        data-testid={`toggle-${tool.id}`}
        onClick={() => onToggle(tool.id, tool.enabled)}
        type="button"
      >
        Toggle
      </button>
      {onExpand && (
        <button data-testid={`expand-${tool.id}`} onClick={() => onExpand(tool.id)} type="button">
          Expand
        </button>
      )}
    </div>
  ),
}));

vi.mock('../tool-row-expanded', () => ({
  ToolRowExpanded: ({ tool }: { tool: ToolDisplayMetadata }) => (
    <div data-testid={`tool-row-expanded-${tool.id}`}>Expanded: {tool.id}</div>
  ),
}));

// Mock @brainstrike/ui
vi.mock('@brainstrike/ui', () => ({
  Accordion: ({
    children,
    type,
    defaultValue,
  }: {
    children: React.ReactNode;
    type?: string;
    defaultValue?: string[];
  }) => (
    <div data-default-value={defaultValue?.join(',')} data-testid="accordion" data-type={type}>
      {children}
    </div>
  ),
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Card: ({ children }: { children: React.ReactNode }) => <div data-testid="card">{children}</div>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe('UnifiedToolsSettings', () => {
  const mockTools: ToolDisplayMetadata[] = [
    {
      id: 'brainstrike.hybridSearch',
      source: 'native',
      category: 'retrieval',
      loadingTier: 'critical',
      description: 'Hybrid search tool',
      enabled: true,
      estimatedTokens: 150,
      requiresApproval: false,
    },
    {
      id: 'brainstrike.vectorSearch',
      source: 'native',
      category: 'retrieval',
      loadingTier: 'conditional',
      description: 'Vector search tool',
      enabled: false,
      estimatedTokens: 100,
      requiresApproval: false,
    },
    {
      id: 'mcp__github__search_code',
      source: 'mcp',
      category: 'retrieval',
      loadingTier: 'conditional',
      description: 'GitHub code search',
      enabled: true,
      serverName: 'github',
      estimatedTokens: 200,
      requiresApproval: false,
    },
  ];

  const mockStats: ToolStats = {
    total: 3,
    enabled: 2,
    disabled: 1,
    bySource: { native: 2, mcp: 1 },
    byCategory: {
      retrieval: 3,
      action: 0,
      analysis: 0,
      configuration: 0,
      validation: 0,
    },
    mcpServers: 1,
  };

  const createMockOperations = (): ToolsSettingsOperations => ({
    getTools: vi.fn().mockResolvedValue(mockTools),
    getStats: vi.fn().mockResolvedValue(mockStats),
    enableTools: vi.fn().mockResolvedValue(undefined),
    disableTools: vi.fn().mockResolvedValue(undefined),
    resetTools: vi.fn().mockResolvedValue(undefined),
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('loading state', () => {
    it('shows loading state initially', () => {
      const operations = createMockOperations();
      operations.getTools = vi.fn().mockReturnValue(new Promise(() => {}));

      render(<UnifiedToolsSettings operations={operations} />);

      expect(screen.getByText('Loading tools...')).toBeInTheDocument();
    });

    it('hides loading state after data loads', async () => {
      const operations = createMockOperations();

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        expect(screen.queryByText('Loading tools...')).not.toBeInTheDocument();
      });
    });
  });

  describe('empty state', () => {
    it('shows empty state when no tools are available', async () => {
      const operations = createMockOperations();
      operations.getTools = vi.fn().mockResolvedValue([]);
      operations.getStats = vi.fn().mockResolvedValue({ ...mockStats, total: 0 });

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        expect(screen.getByText(/No tools registered/)).toBeInTheDocument();
      });
    });
  });

  describe('error handling', () => {
    it('displays error message when loading fails', async () => {
      const operations = createMockOperations();
      operations.getTools = vi.fn().mockRejectedValue(new Error('Network error'));

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        expect(screen.getByText('Network error')).toBeInTheDocument();
      });
    });
  });

  describe('accordion-based tool display', () => {
    it('renders tools in accordion layout', async () => {
      const operations = createMockOperations();

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('accordion')).toBeInTheDocument();
        expect(screen.getByTestId('accordion')).toHaveAttribute('data-type', 'multiple');
      });
    });

    it('groups native tools separately from MCP tools', async () => {
      const operations = createMockOperations();

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('tool-group-native')).toBeInTheDocument();
        expect(screen.getByTestId('tool-group-mcp-github')).toBeInTheDocument();
      });
    });

    it('shows correct enabled count for each group', async () => {
      const operations = createMockOperations();

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        // Native: 1 enabled, 2 total
        expect(screen.getByTestId('enabled-count-native')).toHaveTextContent('1/2');
        // MCP github: 1 enabled, 1 total
        expect(screen.getByTestId('enabled-count-mcp-github')).toHaveTextContent('1/1');
      });
    });

    it('renders ToolRow for each tool', async () => {
      const operations = createMockOperations();

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('tool-row-brainstrike.hybridSearch')).toBeInTheDocument();
        expect(screen.getByTestId('tool-row-brainstrike.vectorSearch')).toBeInTheDocument();
        expect(screen.getByTestId('tool-row-mcp__github__search_code')).toBeInTheDocument();
      });
    });
  });

  describe('expand/collapse functionality', () => {
    it('expands tool row when clicked', async () => {
      const operations = createMockOperations();

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('tool-row-brainstrike.hybridSearch')).toBeInTheDocument();
      });

      const expandButton = screen.getByTestId('expand-brainstrike.hybridSearch');
      fireEvent.click(expandButton);

      await waitFor(() => {
        expect(
          screen.getByTestId('tool-row-expanded-brainstrike.hybridSearch')
        ).toBeInTheDocument();
      });
    });

    it('collapses expanded tool row when clicked again', async () => {
      const operations = createMockOperations();

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('tool-row-brainstrike.hybridSearch')).toBeInTheDocument();
      });

      // First click to expand
      const expandButton = screen.getByTestId('expand-brainstrike.hybridSearch');
      fireEvent.click(expandButton);

      await waitFor(() => {
        expect(
          screen.getByTestId('tool-row-expanded-brainstrike.hybridSearch')
        ).toBeInTheDocument();
      });

      // Second click to collapse
      fireEvent.click(expandButton);

      await waitFor(() => {
        expect(
          screen.queryByTestId('tool-row-expanded-brainstrike.hybridSearch')
        ).not.toBeInTheDocument();
      });
    });
  });

  describe('filter bar with totalCount', () => {
    it('renders filter bar when tools exist', async () => {
      const operations = createMockOperations();

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('tools-filter-bar')).toBeInTheDocument();
      });
    });

    it('passes totalCount to filter bar', async () => {
      const operations = createMockOperations();

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('total-count')).toHaveTextContent('3 tools');
      });
    });

    it('filters tools by search query', async () => {
      const operations = createMockOperations();

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('tool-row-brainstrike.hybridSearch')).toBeInTheDocument();
      });

      const searchInput = screen.getByTestId('search-input');
      fireEvent.change(searchInput, { target: { value: 'github' } });

      await waitFor(() => {
        expect(screen.queryByTestId('tool-row-brainstrike.hybridSearch')).not.toBeInTheDocument();
        expect(screen.getByTestId('tool-row-mcp__github__search_code')).toBeInTheDocument();
      });
    });
  });

  describe('toggle functionality', () => {
    it('calls disableTools when toggling an enabled tool', async () => {
      const operations = createMockOperations();

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('tool-row-brainstrike.hybridSearch')).toBeInTheDocument();
      });

      const toggleButton = screen.getByTestId('toggle-brainstrike.hybridSearch');
      fireEvent.click(toggleButton);

      await waitFor(() => {
        expect(operations.disableTools).toHaveBeenCalledWith(['brainstrike.hybridSearch']);
      });
    });

    it('calls enableTools when toggling a disabled tool', async () => {
      const operations = createMockOperations();

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('tool-row-brainstrike.vectorSearch')).toBeInTheDocument();
      });

      const toggleButton = screen.getByTestId('toggle-brainstrike.vectorSearch');
      fireEvent.click(toggleButton);

      await waitFor(() => {
        expect(operations.enableTools).toHaveBeenCalledWith(['brainstrike.vectorSearch']);
      });
    });

    it('calls onToolsChanged after toggling', async () => {
      const operations = createMockOperations();
      const onToolsChanged = vi.fn();

      render(<UnifiedToolsSettings onToolsChanged={onToolsChanged} operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('tool-row-brainstrike.hybridSearch')).toBeInTheDocument();
      });

      const toggleButton = screen.getByTestId('toggle-brainstrike.hybridSearch');
      fireEvent.click(toggleButton);

      await waitFor(() => {
        expect(onToolsChanged).toHaveBeenCalled();
      });
    });
  });

  describe('group actions', () => {
    it('enables all native tools when Enable All is clicked', async () => {
      const operations = createMockOperations();

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('enable-all-native')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('enable-all-native'));

      await waitFor(() => {
        expect(operations.enableTools).toHaveBeenCalledWith([
          'brainstrike.hybridSearch',
          'brainstrike.vectorSearch',
        ]);
      });
    });

    it('disables all native tools when Disable All is clicked', async () => {
      const operations = createMockOperations();

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('disable-all-native')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('disable-all-native'));

      await waitFor(() => {
        expect(operations.disableTools).toHaveBeenCalledWith([
          'brainstrike.hybridSearch',
          'brainstrike.vectorSearch',
        ]);
      });
    });
  });

  describe('MCP integration', () => {
    it('does not show MCP config alert when mcpAvailable is false', async () => {
      const operations = createMockOperations();
      operations.getMcpConfigInfo = vi.fn().mockResolvedValue({ path: '/test', exists: false });

      render(<UnifiedToolsSettings mcpAvailable={false} operations={operations} />);

      await waitFor(() => {
        expect(screen.queryByTestId('mcp-config-alert')).not.toBeInTheDocument();
      });
    });

    it('shows MCP config alert when config is missing', async () => {
      const operations = createMockOperations();
      operations.getMcpConfigInfo = vi.fn().mockResolvedValue({ path: '/test', exists: false });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('mcp-config-alert')).toBeInTheDocument();
      });
    });

    it('hides MCP config alert when dismissed', async () => {
      const operations = createMockOperations();
      operations.getMcpConfigInfo = vi.fn().mockResolvedValue({ path: '/test', exists: false });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('mcp-config-alert')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('dismiss-alert'));

      await waitFor(() => {
        expect(screen.queryByTestId('mcp-config-alert')).not.toBeInTheDocument();
      });
    });

    it('shows connection status in MCP group accordion', async () => {
      const operations = createMockOperations();
      operations.getMcpServerStatus = vi
        .fn()
        .mockResolvedValue([{ name: 'github', status: 'connected', toolCount: 1 }]);

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('connection-status-mcp-github')).toHaveTextContent('connected');
      });
    });
  });

  describe('budget manager', () => {
    it('does not show budget summary when budgetManager is not provided', async () => {
      const operations = createMockOperations();

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        expect(screen.queryByTestId('token-budget-summary')).not.toBeInTheDocument();
      });
    });

    it('shows budget summary when budgetManager is provided', async () => {
      const operations = createMockOperations();
      const mockBudgetManager = {
        getCriticalToolsBudget: () => 5000,
        getConditionalToolsBudget: () => 10_000,
        getContextResultsBudget: () => 20_000,
      };

      render(
        <UnifiedToolsSettings budgetManager={mockBudgetManager as never} operations={operations} />
      );

      await waitFor(() => {
        expect(screen.getByTestId('token-budget-summary')).toBeInTheDocument();
      });
    });
  });
});
