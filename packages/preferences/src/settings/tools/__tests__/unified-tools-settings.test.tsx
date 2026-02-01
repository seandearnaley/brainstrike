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

vi.mock('../mcp-server-status', () => ({
  McpServerStatus: () => <div data-testid="mcp-server-status">MCP Status</div>,
}));

vi.mock('../tools-filter-bar', () => ({
  ToolsFilterBar: ({
    onSearchChange,
    onReset,
  }: {
    onSearchChange: (q: string) => void;
    onReset: () => void;
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
    </div>
  ),
}));

vi.mock('../tool-card', () => ({
  ToolCard: ({
    tool,
    onToggle,
  }: {
    tool: ToolDisplayMetadata;
    onToggle: (id: string, enabled: boolean) => Promise<void>;
  }) => (
    <div data-testid={`tool-card-${tool.id}`}>
      <span>{tool.id}</span>
      <button onClick={() => onToggle(tool.id, tool.enabled)} type="button">
        Toggle
      </button>
    </div>
  ),
}));

// Mock @brainstrike/ui
vi.mock('@brainstrike/ui', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="badge">{children}</span>
  ),
  Card: ({ children }: { children: React.ReactNode }) => <div data-testid="card">{children}</div>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>,
  CardDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
    total: 2,
    enabled: 2,
    disabled: 0,
    bySource: { native: 1, mcp: 1 },
    byCategory: {
      retrieval: 2,
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
      // Make getTools never resolve to keep loading state
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

  describe('tool display', () => {
    it('renders tools after loading', async () => {
      const operations = createMockOperations();

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('tool-card-brainstrike.hybridSearch')).toBeInTheDocument();
        expect(screen.getByTestId('tool-card-mcp__github__search_code')).toBeInTheDocument();
      });
    });

    it('groups native tools separately from MCP tools', async () => {
      const operations = createMockOperations();

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        expect(screen.getByText('Native Tools')).toBeInTheDocument();
        expect(screen.getByText('github')).toBeInTheDocument();
      });
    });

    it('shows enabled count for each group', async () => {
      const operations = createMockOperations();

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        // Both groups have 1/1 enabled, so we should find multiple
        const enabledCounts = screen.getAllByText('1/1 enabled');
        expect(enabledCounts.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe('stats display', () => {
    it('displays tool statistics', async () => {
      const operations = createMockOperations();

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        expect(screen.getByText('2 total')).toBeInTheDocument();
        expect(screen.getByText('2 enabled')).toBeInTheDocument();
        expect(screen.getByText('0 disabled')).toBeInTheDocument();
      });
    });

    it('shows MCP server count when available', async () => {
      const operations = createMockOperations();

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        expect(screen.getByText('1 MCP servers')).toBeInTheDocument();
      });
    });
  });

  describe('filtering', () => {
    it('renders filter bar when tools exist', async () => {
      const operations = createMockOperations();

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('tools-filter-bar')).toBeInTheDocument();
      });
    });

    it('does not render filter bar when no tools exist', async () => {
      const operations = createMockOperations();
      operations.getTools = vi.fn().mockResolvedValue([]);

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        expect(screen.queryByTestId('tools-filter-bar')).not.toBeInTheDocument();
      });
    });

    it('filters tools by search query', async () => {
      const operations = createMockOperations();

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('tool-card-brainstrike.hybridSearch')).toBeInTheDocument();
      });

      // Search for 'github'
      const searchInput = screen.getByTestId('search-input');
      fireEvent.change(searchInput, { target: { value: 'github' } });

      await waitFor(() => {
        expect(screen.queryByTestId('tool-card-brainstrike.hybridSearch')).not.toBeInTheDocument();
        expect(screen.getByTestId('tool-card-mcp__github__search_code')).toBeInTheDocument();
      });
    });
  });

  describe('toggle functionality', () => {
    it('calls disableTools when toggling an enabled tool', async () => {
      const operations = createMockOperations();

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('tool-card-brainstrike.hybridSearch')).toBeInTheDocument();
      });

      // Find and click the toggle button
      const toolCard = screen.getByTestId('tool-card-brainstrike.hybridSearch');
      const toggleButton = toolCard.querySelector('button');
      fireEvent.click(toggleButton!);

      await waitFor(() => {
        expect(operations.disableTools).toHaveBeenCalledWith(['brainstrike.hybridSearch']);
      });
    });

    it('calls onToolsChanged after toggling', async () => {
      const operations = createMockOperations();
      const onToolsChanged = vi.fn();

      render(<UnifiedToolsSettings onToolsChanged={onToolsChanged} operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('tool-card-brainstrike.hybridSearch')).toBeInTheDocument();
      });

      const toolCard = screen.getByTestId('tool-card-brainstrike.hybridSearch');
      const toggleButton = toolCard.querySelector('button');
      fireEvent.click(toggleButton!);

      await waitFor(() => {
        expect(onToolsChanged).toHaveBeenCalled();
      });
    });
  });

  describe('MCP integration', () => {
    it('does not show MCP status when mcpAvailable is false', async () => {
      const operations = createMockOperations();
      operations.getMcpServerStatus = vi
        .fn()
        .mockResolvedValue([{ name: 'test', status: 'connected', toolCount: 5 }]);

      render(<UnifiedToolsSettings mcpAvailable={false} operations={operations} />);

      await waitFor(() => {
        expect(screen.queryByTestId('mcp-server-status')).not.toBeInTheDocument();
      });
    });

    it('shows MCP status when mcpAvailable is true and servers exist', async () => {
      const operations = createMockOperations();
      operations.getMcpServerStatus = vi
        .fn()
        .mockResolvedValue([{ name: 'test', status: 'connected', toolCount: 5 }]);

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('mcp-server-status')).toBeInTheDocument();
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
