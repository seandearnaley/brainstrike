/**
 * Unified Tools Settings Tests
 */

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ToolDisplayMetadata,
  ToolExecutionResult,
  ToolStats,
  ToolsSettingsOperations,
} from '../types';
import { UnifiedToolsSettings } from '../unified-tools-settings';

const { useBrainstrikeLiveQueryMock } = vi.hoisted(() => ({
  useBrainstrikeLiveQueryMock: vi.fn(() => ({
    rows: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
  })),
}));

vi.mock('@brainstrike/db', () => ({
  useBrainstrikeLiveQuery: useBrainstrikeLiveQueryMock,
}));

// Mock child components
vi.mock('../token-budget-summary', () => ({
  TokenBudgetSummary: () => <div data-testid="token-budget-summary">Budget Summary</div>,
}));

vi.mock('../mcp-config-alert', () => ({
  McpConfigAlert: ({
    onCreateSample,
    onDismiss,
  }: {
    onCreateSample?: () => Promise<void>;
    onDismiss?: () => void;
  }) => (
    <div data-testid="mcp-config-alert">
      MCP Config Alert
      {onCreateSample && (
        <button
          data-testid="create-sample-config"
          onClick={() => void onCreateSample()}
          type="button"
        >
          Create Sample
        </button>
      )}
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

const { ToolGroupAccordionMock, renderToolGroupAccordion } = vi.hoisted(() => {
  const renderToolGroupAccordion = ({
    id,
    label,
    enabledCount,
    totalCount,
    onEnableAll,
    onDisableAll,
    children,
    connectionStatus,
    onRefreshConnection,
    onOpenConfigFile,
  }: {
    id: string;
    label: string;
    enabledCount: number;
    totalCount: number;
    onEnableAll: () => void;
    onDisableAll: () => void;
    children: React.ReactNode;
    connectionStatus?: string;
    onRefreshConnection?: () => void;
    onOpenConfigFile?: () => void;
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
        {onRefreshConnection && (
          <button
            data-testid={`refresh-connection-${id}`}
            onClick={onRefreshConnection}
            type="button"
          >
            Refresh
          </button>
        )}
        {onOpenConfigFile && (
          <button data-testid={`open-config-${id}`} onClick={onOpenConfigFile} type="button">
            Open Config
          </button>
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
  );

  return {
    ToolGroupAccordionMock: vi.fn(renderToolGroupAccordion),
    renderToolGroupAccordion,
  };
});

vi.mock('../tool-group-accordion', () => ({
  ToolGroupAccordion: ToolGroupAccordionMock,
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

interface CardMockProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  'data-testid'?: string;
}

interface CardContentMockProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

// Mock @brainstrike/ui (override layout components, keep ErrorBoundary/Button)
vi.mock('@brainstrike/ui', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/ui')>('@brainstrike/ui');
  return {
    ...actual,
    Tabs: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="tabs-container">{children}</div>
    ),
    TabsList: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="tabs-list">{children}</div>
    ),
    TabsTrigger: ({
      children,
      value,
      onClick,
    }: {
      children: React.ReactNode;
      value?: string;
      onClick?: () => void;
    }) => (
      <button data-testid={`tabs-trigger-${value ?? 'unknown'}`} onClick={onClick} type="button">
        {children}
      </button>
    ),
    TabsContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
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
    Card: ({ children, 'data-testid': dataTestId, ...rest }: CardMockProps) => {
      const testId = dataTestId ?? 'card';
      return (
        <div {...rest} data-testid={testId}>
          {children}
        </div>
      );
    },
    CardContent: ({ children, ...rest }: CardContentMockProps) => <div {...rest}>{children}</div>,
  };
});

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
    useBrainstrikeLiveQueryMock.mockReturnValue({
      rows: [],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    localStorage.clear();
  });

  describe('live query configuration', () => {
    it('passes incremental query mode and key through for keyed live tool rows', () => {
      const operations = createMockOperations();
      operations.toolsLiveQuery = {
        query: 'SELECT id FROM tools ORDER BY id',
        mode: 'incremental',
        key: 'id',
      };

      render(<UnifiedToolsSettings operations={operations} />);

      expect(useBrainstrikeLiveQueryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'SELECT id FROM tools ORDER BY id',
          enabled: true,
          mode: 'incremental',
          key: 'id',
        })
      );
    });
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

    it('shows an error fallback when a tool group crashes and retries on demand', async () => {
      const operations = createMockOperations();
      ToolGroupAccordionMock.mockImplementation(() => {
        throw new Error('Crash in tool group');
      });

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('tools-error-fallback')).toBeInTheDocument();
      });

      ToolGroupAccordionMock.mockImplementation(renderToolGroupAccordion);
      fireEvent.click(screen.getByRole('button', { name: /retry/i }));

      await waitFor(() => {
        expect(operations.getTools).toHaveBeenCalledTimes(2);
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

    it('resets the search filter from the filter bar', async () => {
      const operations = createMockOperations();

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('tool-row-brainstrike.hybridSearch')).toBeInTheDocument();
      });

      fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'github' } });

      await waitFor(() => {
        expect(screen.queryByTestId('tool-row-brainstrike.hybridSearch')).not.toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('reset-button'));

      await waitFor(() => {
        expect(screen.getByTestId('tool-row-brainstrike.hybridSearch')).toBeInTheDocument();
        expect(screen.getByTestId('tool-row-brainstrike.vectorSearch')).toBeInTheDocument();
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

    it('shows toggle errors without reporting a successful tools change', async () => {
      const operations = createMockOperations();
      operations.disableTools = vi.fn().mockRejectedValue(new Error('Disable failed'));
      const onToolsChanged = vi.fn();

      render(<UnifiedToolsSettings onToolsChanged={onToolsChanged} operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('tool-row-brainstrike.hybridSearch')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('toggle-brainstrike.hybridSearch'));

      await waitFor(() => {
        expect(screen.getByText('Disable failed')).toBeInTheDocument();
      });
      expect(onToolsChanged).not.toHaveBeenCalled();
    });
  });

  describe('tool execution', () => {
    const expandTool = async (toolId: string) => {
      await waitFor(() => {
        expect(screen.getByTestId(`tool-row-${toolId}`)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId(`expand-${toolId}`));

      await waitFor(() => {
        expect(screen.getByTestId(`tool-row-expanded-${toolId}`)).toBeInTheDocument();
      });

      return screen.getByTestId(`tool-playground-${toolId}`);
    };

    it('executes tool tests successfully and displays duration', async () => {
      const executeToolTest = vi.fn().mockResolvedValue({
        success: true,
        result: { ok: true },
        durationMs: 42,
      });
      const operations = { ...createMockOperations(), executeToolTest };

      render(<UnifiedToolsSettings operations={operations} />);

      const playground = await expandTool('brainstrike.hybridSearch');
      const input = within(playground).getByTestId('json-input');
      fireEvent.change(input, { target: { value: '{"query":"test"}' } });

      fireEvent.click(within(playground).getByTestId('execute-button'));

      await waitFor(() => {
        expect(executeToolTest).toHaveBeenCalledWith('brainstrike.hybridSearch', {
          query: 'test',
        });
      });

      await waitFor(() => {
        const result = within(playground).getByTestId('execution-result');
        expect(result).toHaveTextContent('Success');
        expect(result).toHaveTextContent('42ms');
      });
    });

    it('handles schema validation errors during execution', async () => {
      const executeToolTest = vi.fn().mockResolvedValue({
        success: false,
        error: 'Input schema validation failed',
        durationMs: 8,
      });
      const operations = { ...createMockOperations(), executeToolTest };

      render(<UnifiedToolsSettings operations={operations} />);

      const playground = await expandTool('brainstrike.hybridSearch');
      const input = within(playground).getByTestId('json-input');
      fireEvent.change(input, { target: { value: '{"query":"bad"}' } });

      fireEvent.click(within(playground).getByTestId('execute-button'));

      await waitFor(() => {
        const result = within(playground).getByTestId('execution-result');
        expect(result).toHaveTextContent('Error');
        expect(result).toHaveTextContent('Input schema validation failed');
      });
    });

    it('surfaces timeout failures when execution rejects', async () => {
      const executeToolTest = vi.fn().mockRejectedValue(new Error('Timeout'));
      const operations = { ...createMockOperations(), executeToolTest };

      render(<UnifiedToolsSettings operations={operations} />);

      const playground = await expandTool('brainstrike.hybridSearch');
      const input = within(playground).getByTestId('json-input');
      fireEvent.change(input, { target: { value: '{"query":"timeout"}' } });

      fireEvent.click(within(playground).getByTestId('execute-button'));

      await waitFor(() => {
        const result = within(playground).getByTestId('execution-result');
        expect(result).toHaveTextContent('Error');
        expect(result).toHaveTextContent('Timeout');
      });
    });

    it('rejects invalid JSON input before execution', async () => {
      const executeToolTest = vi.fn().mockResolvedValue({
        success: true,
        result: { ok: true },
        durationMs: 5,
      });
      const operations = { ...createMockOperations(), executeToolTest };

      render(<UnifiedToolsSettings operations={operations} />);

      const playground = await expandTool('brainstrike.hybridSearch');
      const input = within(playground).getByTestId('json-input');
      fireEvent.change(input, { target: { value: '{bad json' } });

      fireEvent.click(within(playground).getByTestId('execute-button'));

      await waitFor(() => {
        expect(within(playground).getByTestId('parse-error')).toBeInTheDocument();
      });
      expect(executeToolTest).not.toHaveBeenCalled();
    });

    it('supports concurrent executions across tools', async () => {
      const pending = new Map<string, (result: ToolExecutionResult) => void>();
      const executeToolTest = vi.fn().mockImplementation(
        (toolId: string) =>
          new Promise((resolve) => {
            pending.set(toolId, resolve);
          })
      );
      const operations = { ...createMockOperations(), executeToolTest };

      render(<UnifiedToolsSettings operations={operations} />);

      const firstPlayground = await expandTool('brainstrike.hybridSearch');
      fireEvent.change(within(firstPlayground).getByTestId('json-input'), {
        target: { value: '{"query":"one"}' },
      });
      fireEvent.click(within(firstPlayground).getByTestId('execute-button'));

      await waitFor(() => {
        expect(executeToolTest).toHaveBeenCalledTimes(1);
      });

      const secondPlayground = await expandTool('brainstrike.vectorSearch');
      fireEvent.change(within(secondPlayground).getByTestId('json-input'), {
        target: { value: '{"query":"two"}' },
      });
      fireEvent.click(within(secondPlayground).getByTestId('execute-button'));

      await waitFor(() => {
        expect(executeToolTest).toHaveBeenCalledTimes(2);
      });

      expect(pending.has('brainstrike.hybridSearch')).toBe(true);
      expect(pending.has('brainstrike.vectorSearch')).toBe(true);

      pending.get('brainstrike.hybridSearch')?.({
        success: true,
        result: { ok: 1 },
        durationMs: 11,
      });
      pending.get('brainstrike.vectorSearch')?.({
        success: true,
        result: { ok: 2 },
        durationMs: 22,
      });

      await waitFor(() => {
        expect(within(secondPlayground).getByTestId('execution-result')).toHaveTextContent('22ms');
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
    it('shows MCP editor unavailable fallback when config text operations are missing', async () => {
      const operations = createMockOperations();

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      await waitFor(() => {
        expect(
          screen.getByText('MCP config editing is unavailable in this runtime.')
        ).toBeInTheDocument();
      });
    });

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

    it('shows sample config creation errors from the missing-config alert', async () => {
      const operations = createMockOperations();
      operations.getMcpConfigInfo = vi.fn().mockResolvedValue({ path: '/test', exists: false });
      operations.createSampleConfig = vi.fn().mockResolvedValue({
        success: false,
        error: 'template write failed',
      });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('create-sample-config')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('create-sample-config'));

      await waitFor(() => {
        expect(
          screen.getByText('Failed to create sample config: template write failed')
        ).toBeInTheDocument();
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

    it('opens the MCP config from an MCP group header action', async () => {
      const operations = createMockOperations();
      operations.openMcpConfig = vi.fn().mockResolvedValue(undefined);
      operations.getMcpServerStatus = vi
        .fn()
        .mockResolvedValue([{ name: 'github', status: 'disconnected', toolCount: 1 }]);

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('open-config-mcp-github')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('open-config-mcp-github'));

      await waitFor(() => {
        expect(operations.openMcpConfig).toHaveBeenCalledTimes(1);
      });
    });

    it('recovers after MCP status errors when refreshed', async () => {
      const operations = createMockOperations();
      operations.getMcpServerStatus = vi
        .fn()
        .mockRejectedValueOnce(new Error('MCP down'))
        .mockResolvedValueOnce([{ name: 'github', status: 'connected', toolCount: 1 }]);
      operations.refreshMcpServers = vi.fn().mockResolvedValue(undefined);

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      await waitFor(() => {
        expect(screen.getByText('MCP down')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('refresh-connection-mcp-github'));

      await waitFor(() => {
        expect(operations.refreshMcpServers).toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(screen.getByTestId('connection-status-mcp-github')).toHaveTextContent('connected');
      });

      await waitFor(() => {
        expect(screen.queryByText('MCP down')).not.toBeInTheDocument();
      });
    });

    it('loads MCP config editor content when editor operations are provided', async () => {
      const operations = createMockOperations();
      operations.readMcpConfigText = vi.fn().mockResolvedValue({
        path: '/tmp/mcp.config.json',
        exists: true,
        created: false,
        content: '{\n  "servers": []\n}',
      });
      operations.writeMcpConfigText = vi
        .fn()
        .mockResolvedValue({ success: true, path: '/tmp/mcp.config.json' });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      await waitFor(() => {
        expect(operations.readMcpConfigText).toHaveBeenCalled();
      });

      expect(screen.getByTestId('mcp-config-editor')).toBeInTheDocument();
      expect(screen.getByTestId('mcp-config-path-input')).toHaveValue('/tmp/mcp.config.json');
    });

    it('saves MCP config editor content', async () => {
      const operations = createMockOperations();
      operations.readMcpConfigText = vi.fn().mockResolvedValue({
        path: '/tmp/mcp.config.json',
        exists: true,
        created: false,
        content: '{\n  "servers": []\n}',
      });
      operations.writeMcpConfigText = vi
        .fn()
        .mockResolvedValue({ success: true, path: '/tmp/mcp.config.json' });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('mcp-config-editor')).toBeInTheDocument();
      });

      fireEvent.change(screen.getByTestId('mcp-config-editor'), {
        target: { value: '{\n  "servers": [{"transport":"stdio","name":"x","command":"node"}]\n}' },
      });
      fireEvent.click(screen.getByTestId('mcp-config-save'));

      await waitFor(() => {
        expect(operations.writeMcpConfigText).toHaveBeenCalled();
      });
    });

    it('applies an absolute MCP config path and shows a success status', async () => {
      const operations = createMockOperations();
      operations.readMcpConfigText = vi.fn().mockResolvedValue({
        path: '/tmp/mcp.config.json',
        exists: true,
        created: false,
        content: '{\n  "servers": []\n}',
      });
      operations.writeMcpConfigText = vi
        .fn()
        .mockResolvedValue({ success: true, path: '/tmp/mcp.config.json' });
      operations.setMcpConfigPath = vi.fn().mockResolvedValue(undefined);

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('mcp-config-path-input')).toBeInTheDocument();
      });

      fireEvent.change(screen.getByTestId('mcp-config-path-input'), {
        target: { value: '/tmp/custom.config.json' },
      });
      fireEvent.click(screen.getByTestId('mcp-config-apply-path'));

      await waitFor(() => {
        expect(operations.setMcpConfigPath).toHaveBeenCalledWith('/tmp/custom.config.json');
      });

      await waitFor(() => {
        expect(screen.getByTestId('mcp-config-status')).toHaveTextContent(
          'MCP config path updated.'
        );
      });
    });

    it('resets MCP config path when apply is clicked with whitespace input', async () => {
      const operations = createMockOperations();
      operations.readMcpConfigText = vi.fn().mockResolvedValue({
        path: '/tmp/mcp.config.json',
        exists: true,
        created: false,
        content: '{\n  "servers": []\n}',
      });
      operations.writeMcpConfigText = vi
        .fn()
        .mockResolvedValue({ success: true, path: '/tmp/mcp.config.json' });
      operations.setMcpConfigPath = vi.fn().mockResolvedValue(undefined);

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('mcp-config-path-input')).toBeInTheDocument();
      });

      fireEvent.change(screen.getByTestId('mcp-config-path-input'), {
        target: { value: '   ' },
      });
      fireEvent.click(screen.getByTestId('mcp-config-apply-path'));

      await waitFor(() => {
        expect(operations.setMcpConfigPath).toHaveBeenCalledWith(null);
      });
    });

    it('shows an error when MCP config save fails validation', async () => {
      const operations = createMockOperations();
      operations.readMcpConfigText = vi.fn().mockResolvedValue({
        path: '/tmp/mcp.config.json',
        exists: true,
        created: false,
        content: '{\n  "servers": []\n}',
      });
      operations.writeMcpConfigText = vi.fn().mockResolvedValue({
        success: false,
        path: '/tmp/mcp.config.json',
        error: 'Invalid JSONC payload',
      });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('mcp-config-editor')).toBeInTheDocument();
      });

      fireEvent.change(screen.getByTestId('mcp-config-editor'), {
        target: { value: '{ "servers": [ }' },
      });
      fireEvent.click(screen.getByTestId('mcp-config-save'));

      await waitFor(() => {
        expect(screen.getByTestId('mcp-config-error')).toHaveTextContent('Invalid JSONC payload');
      });
    });

    it('runs browse and reset path actions from the MCP editor controls', async () => {
      const operations = createMockOperations();
      operations.readMcpConfigText = vi.fn().mockResolvedValue({
        path: '/tmp/mcp.config.json',
        exists: true,
        created: false,
        content: '{\n  "servers": []\n}',
      });
      operations.writeMcpConfigText = vi
        .fn()
        .mockResolvedValue({ success: true, path: '/tmp/mcp.config.json' });
      operations.openMcpConfig = vi.fn().mockResolvedValue(undefined);
      operations.resetMcpConfig = vi.fn().mockResolvedValue(undefined);

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('mcp-config-browse-path')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('mcp-config-browse-path'));
      await waitFor(() => {
        expect(operations.openMcpConfig).toHaveBeenCalledTimes(1);
      });

      fireEvent.click(screen.getByTestId('mcp-config-reset-path'));
      await waitFor(() => {
        expect(operations.resetMcpConfig).toHaveBeenCalledTimes(1);
      });

      await waitFor(() => {
        expect(screen.getByTestId('mcp-config-status')).toHaveTextContent(
          'MCP config path reset to default.'
        );
      });
    });

    it('shows created-template status when config is auto-created on load', async () => {
      const operations = createMockOperations();
      operations.readMcpConfigText = vi.fn().mockResolvedValue({
        path: '/tmp/mcp.config.json',
        exists: false,
        created: true,
        content: '{\n  "servers": []\n}',
      });
      operations.writeMcpConfigText = vi
        .fn()
        .mockResolvedValue({ success: true, path: '/tmp/mcp.config.json' });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('mcp-config-status')).toHaveTextContent(
          'Created a new MCP config template with commented examples.'
        );
      });
    });

    it('shows MCP editor load errors when reading config text fails', async () => {
      const operations = createMockOperations();
      operations.readMcpConfigText = vi.fn().mockRejectedValue(new Error('Config read failed'));
      operations.writeMcpConfigText = vi
        .fn()
        .mockResolvedValue({ success: true, path: '/tmp/mcp.config.json' });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('mcp-config-error')).toHaveTextContent('Config read failed');
      });
    });

    it('rejects relative MCP config paths in the editor', async () => {
      const operations = createMockOperations();
      operations.readMcpConfigText = vi.fn().mockResolvedValue({
        path: '/tmp/mcp.config.json',
        exists: true,
        created: false,
        content: '{\n  "servers": []\n}',
      });
      operations.writeMcpConfigText = vi
        .fn()
        .mockResolvedValue({ success: true, path: '/tmp/mcp.config.json' });
      operations.setMcpConfigPath = vi.fn().mockResolvedValue(undefined);

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('mcp-config-path-input')).toBeInTheDocument();
      });

      fireEvent.change(screen.getByTestId('mcp-config-path-input'), {
        target: { value: 'relative/mcp.config.json' },
      });
      fireEvent.click(screen.getByTestId('mcp-config-apply-path'));

      await waitFor(() => {
        expect(
          screen.getByText('Please provide an absolute path to the MCP config file.')
        ).toBeInTheDocument();
      });
      expect(operations.setMcpConfigPath).not.toHaveBeenCalled();
    });

    it('confirms before discarding unsaved editor changes on reload', async () => {
      const operations = createMockOperations();
      operations.readMcpConfigText = vi.fn().mockResolvedValue({
        path: '/tmp/mcp.config.json',
        exists: true,
        created: false,
        content: '{\n  "servers": []\n}',
      });
      operations.writeMcpConfigText = vi
        .fn()
        .mockResolvedValue({ success: true, path: '/tmp/mcp.config.json' });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('mcp-config-editor')).toBeInTheDocument();
      });

      fireEvent.change(screen.getByTestId('mcp-config-editor'), {
        target: {
          value: '{\n  "servers": [{"transport":"stdio","name":"x","command":"node"}]\n}',
        },
      });
      fireEvent.click(screen.getByTestId('mcp-config-reload'));

      expect(screen.getByTestId('mcp-config-reload-confirm')).toBeInTheDocument();
      expect(operations.readMcpConfigText).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByTestId('mcp-config-reload-confirm-discard'));

      await waitFor(() => {
        expect(operations.readMcpConfigText).toHaveBeenCalledTimes(2);
      });

      await waitFor(() => {
        expect(screen.queryByTestId('mcp-config-reload-confirm')).not.toBeInTheDocument();
      });
    });

    it('keeps unsaved changes when reload confirmation is canceled', async () => {
      const operations = createMockOperations();
      operations.readMcpConfigText = vi.fn().mockResolvedValue({
        path: '/tmp/mcp.config.json',
        exists: true,
        created: false,
        content: '{\n  "servers": []\n}',
      });
      operations.writeMcpConfigText = vi
        .fn()
        .mockResolvedValue({ success: true, path: '/tmp/mcp.config.json' });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('mcp-config-editor')).toBeInTheDocument();
      });

      fireEvent.change(screen.getByTestId('mcp-config-editor'), {
        target: {
          value: '{\n  "servers": [{"transport":"stdio","name":"keep","command":"node"}]\n}',
        },
      });
      fireEvent.click(screen.getByTestId('mcp-config-reload'));
      expect(screen.getByTestId('mcp-config-reload-confirm')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('mcp-config-reload-confirm-cancel'));

      await waitFor(() => {
        expect(screen.queryByTestId('mcp-config-reload-confirm')).not.toBeInTheDocument();
      });
      expect(screen.getByTestId('mcp-config-editor')).toHaveValue(
        '{\n  "servers": [{"transport":"stdio","name":"keep","command":"node"}]\n}'
      );
      expect(operations.readMcpConfigText).toHaveBeenCalledTimes(1);
    });

    it('exposes accessible labels for MCP config path and editor fields', async () => {
      const operations = createMockOperations();
      operations.readMcpConfigText = vi.fn().mockResolvedValue({
        path: '/tmp/mcp.config.json',
        exists: true,
        created: false,
        content: '{\n  "servers": []\n}',
      });
      operations.writeMcpConfigText = vi
        .fn()
        .mockResolvedValue({ success: true, path: '/tmp/mcp.config.json' });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      await waitFor(() => {
        expect(screen.getByLabelText('MCP Config Path')).toBeInTheDocument();
        expect(screen.getByLabelText('Config Editor (JSONC)')).toBeInTheDocument();
      });
    });

    it('associates status and error feedback with the editor via aria-describedby', async () => {
      const operations = createMockOperations();
      operations.readMcpConfigText = vi.fn().mockResolvedValue({
        path: '/tmp/mcp.config.json',
        exists: false,
        created: true,
        content: '{\n  "servers": []\n}',
      });
      operations.writeMcpConfigText = vi.fn().mockResolvedValue({
        success: false,
        path: '/tmp/mcp.config.json',
        error: 'Invalid JSONC payload',
      });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      const editor = await screen.findByTestId('mcp-config-editor');
      await waitFor(() => {
        expect(screen.getByTestId('mcp-config-status')).toHaveTextContent(
          'Created a new MCP config template with commented examples.'
        );
      });
      expect(editor).toHaveAttribute('aria-describedby', 'mcp-config-status-message');

      fireEvent.change(editor, {
        target: { value: '{ invalid }' },
      });
      fireEvent.click(screen.getByTestId('mcp-config-save'));

      await waitFor(() => {
        expect(screen.getByTestId('mcp-config-error')).toHaveTextContent('Invalid JSONC payload');
      });
      expect(screen.getByTestId('mcp-config-editor')).toHaveAttribute(
        'aria-describedby',
        'mcp-config-error-message'
      );
      expect(screen.getByTestId('mcp-config-editor')).toHaveAttribute('aria-invalid', 'true');
      const statusMessage = screen.queryByTestId('mcp-config-status');
      if (statusMessage) {
        expect(statusMessage).toHaveAttribute('aria-live', 'polite');
      }
      expect(screen.getByTestId('mcp-config-error')).toHaveAttribute('aria-live', 'assertive');
    });

    it('saves MCP config from the editor with Ctrl+S', async () => {
      const operations = createMockOperations();
      operations.readMcpConfigText = vi.fn().mockResolvedValue({
        path: '/tmp/mcp.config.json',
        exists: true,
        created: false,
        content: '{\n  "servers": []\n}',
      });
      operations.writeMcpConfigText = vi
        .fn()
        .mockResolvedValue({ success: true, path: '/tmp/mcp.config.json' });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      const editor = await screen.findByTestId('mcp-config-editor');
      fireEvent.change(editor, {
        target: { value: '{\n  "servers": [{"transport":"stdio","name":"x","command":"node"}]\n}' },
      });
      fireEvent.keyDown(editor, { key: 's', ctrlKey: true });

      await waitFor(() => {
        expect(operations.writeMcpConfigText).toHaveBeenCalledTimes(1);
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
