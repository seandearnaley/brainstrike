/**
 * Unified Tools Settings Tests
 */

import '@testing-library/jest-dom/vitest';
import {
  type McpHostServerSnapshot,
  type McpHostSnapshot,
  parseConfiguredMcpServerId,
} from '@brainstrike/assistant-contract';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  McpConfigInfo,
  McpConfigTextDocument,
  ToolDisplayMetadata,
  ToolExecutionResult,
  ToolStats,
  ToolsSettingsOperations,
} from '../types';
import { UnifiedToolsSettings } from '../unified-tools-settings';

const { usePGliteLiveQueryMock } = vi.hoisted(() => ({
  usePGliteLiveQueryMock: vi.fn(() => ({
    error: null,
    loading: false,
    refresh: vi.fn(),
    rows: [],
  })),
}));

vi.mock('@brainstrike/db', () => ({
  usePGliteLiveQuery: usePGliteLiveQueryMock,
}));
vi.mock('@brainstrike/db/react', () => ({
  usePGliteLiveQuery: usePGliteLiveQueryMock,
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
    renderToolGroupAccordion,
    ToolGroupAccordionMock: vi.fn(renderToolGroupAccordion),
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
    Card: ({ children, 'data-testid': dataTestId, ...rest }: CardMockProps) => {
      const testId = dataTestId ?? 'card';
      return (
        <div {...rest} data-testid={testId}>
          {children}
        </div>
      );
    },
    CardContent: ({ children, ...rest }: CardContentMockProps) => <div {...rest}>{children}</div>,
    Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
    ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Tabs: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="tabs-container">{children}</div>
    ),
    TabsContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    TabsList: ({ children, size }: { children: React.ReactNode; size?: string }) => (
      <div data-size={size} data-testid="tabs-list">
        {children}
      </div>
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
  };
});

describe('UnifiedToolsSettings', () => {
  const mockTools: ToolDisplayMetadata[] = [
    {
      category: 'retrieval',
      description: 'Hybrid search tool',
      enabled: true,
      estimatedTokens: 150,
      id: 'brainstrike.hybridSearch',
      loadingTier: 'critical',
      requiresApproval: false,
      source: 'native',
    },
    {
      category: 'retrieval',
      description: 'Vector search tool',
      enabled: false,
      estimatedTokens: 100,
      id: 'brainstrike.vectorSearch',
      loadingTier: 'conditional',
      requiresApproval: false,
      source: 'native',
    },
    {
      category: 'retrieval',
      description: 'GitHub code search',
      enabled: true,
      estimatedTokens: 200,
      id: 'mcp__github__search_code',
      loadingTier: 'conditional',
      requiresApproval: false,
      serverName: 'github',
      source: 'mcp',
    },
  ];

  const mockStats: ToolStats = {
    byCategory: {
      action: 0,
      analysis: 0,
      configuration: 0,
      retrieval: 3,
      validation: 0,
    },
    bySource: { mcp: 1, native: 2 },
    disabled: 1,
    enabled: 2,
    mcpServers: 1,
    total: 3,
  };

  const createMockOperations = (): ToolsSettingsOperations => ({
    disableTools: vi.fn().mockResolvedValue(undefined),
    enableTools: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockResolvedValue(mockStats),
    getTools: vi.fn().mockResolvedValue(mockTools),
    resetTools: vi.fn().mockResolvedValue(undefined),
  });
  const connectedMcpStatus: McpHostServerSnapshot = {
    configuredProtocol: 'auto',
    configuredServerId: parseConfiguredMcpServerId('github'),
    generation: 1,
    negotiated: {
      advertisedCapabilityIds: ['tools'],
      era: 'modern',
      revision: '2026-07-28',
      serverIdentity: { name: 'github-server', version: '2.0.0' },
    },
    state: 'connected',
    transport: 'streamable-http',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    ToolGroupAccordionMock.mockImplementation(renderToolGroupAccordion);
    usePGliteLiveQueryMock.mockReturnValue({
      error: null,
      loading: false,
      refresh: vi.fn(),
      rows: [],
    });
    localStorage.clear();
  });

  describe('live query configuration', () => {
    it('passes incremental query mode and key through for keyed live tool rows', () => {
      const operations = createMockOperations();
      operations.toolsLiveQuery = {
        key: 'id',
        mode: 'incremental',
        query: 'SELECT id FROM tools ORDER BY id',
      };

      render(<UnifiedToolsSettings operations={operations} />);

      expect(usePGliteLiveQueryMock).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
          key: 'id',
          mode: 'incremental',
          query: 'SELECT id FROM tools ORDER BY id',
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

    it('surfaces an unreadable tool-preferences file instead of presenting the reset list as normal (BST-1615)', async () => {
      const operations = createMockOperations();
      operations.getStats = vi.fn().mockResolvedValue({
        ...mockStats,
        preferencesFault: {
          kind: 'unreadable',
          message:
            'MCP tool preferences could not be loaded from /u/mcp/tool-preferences.json — the file could not be read (EACCES: permission denied).',
          path: '/u/mcp/tool-preferences.json',
        },
      });

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        expect(screen.getByText(/tool-preferences\.json/)).toBeInTheDocument();
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
        durationMs: 42,
        result: { ok: true },
        success: true,
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
        durationMs: 8,
        error: 'Input schema validation failed',
        success: false,
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
        durationMs: 5,
        result: { ok: true },
        success: true,
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
        durationMs: 11,
        result: { ok: 1 },
        success: true,
      });
      pending.get('brainstrike.vectorSearch')?.({
        durationMs: 22,
        result: { ok: 2 },
        success: true,
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

    it('surfaces a failed bulk Enable All instead of dropping the rejection (BST-1615)', async () => {
      const operations = createMockOperations();
      operations.enableTools = vi.fn().mockRejectedValue(new Error('ENOSPC: no space left'));

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('enable-all-native')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('enable-all-native'));

      await waitFor(() => {
        expect(screen.getByText('ENOSPC: no space left')).toBeInTheDocument();
      });
    });

    it('surfaces a failed bulk Disable All instead of dropping the rejection (BST-1615)', async () => {
      const operations = createMockOperations();
      operations.disableTools = vi.fn().mockRejectedValue(new Error('EACCES: permission denied'));

      render(<UnifiedToolsSettings operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('disable-all-native')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('disable-all-native'));

      await waitFor(() => {
        expect(screen.getByText('EACCES: permission denied')).toBeInTheDocument();
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
    it('switches Tools and MCP Config with the full-page (md) switcher', async () => {
      const operations = createMockOperations();

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      expect(await screen.findByTestId('tabs-list')).toHaveAttribute('data-size', 'md');
      expect(screen.getByTestId('tabs-trigger-tools')).toHaveTextContent('Tools');
      expect(screen.getByTestId('tabs-trigger-mcp-config')).toHaveTextContent('MCP Config');
    });

    it('shows MCP editor unavailable fallback when config text operations are missing', async () => {
      const operations = createMockOperations();

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      await waitFor(() => {
        expect(
          screen.getByText('MCP config editing is unavailable in this runtime.')
        ).toBeInTheDocument();
      });
    });

    it('omits the extension switches when the runtime exposes no extension dials', async () => {
      const operations = createMockOperations();

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('mcp-support-matrix')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('mcp-extension-settings')).not.toBeInTheDocument();
      expect(screen.getByTestId('mcp-support-status-io.modelcontextprotocol/ui')).toHaveTextContent(
        'Supported'
      );
    });

    it('renders the extension switches and feeds the support matrix the effective state', async () => {
      const operations = createMockOperations();
      operations.getMcpExtensionPreferences = vi.fn().mockResolvedValue({
        apps: false,
        tasks: true,
      });
      operations.setMcpExtensionPreferences = vi
        .fn()
        .mockImplementation(async (preferences) => preferences);

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('mcp-extension-settings')).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(
          screen.getByTestId('mcp-support-status-io.modelcontextprotocol/ui')
        ).toHaveTextContent('Disabled');
      });
      expect(
        screen.getByTestId('mcp-support-status-io.modelcontextprotocol/tasks')
      ).toHaveTextContent('Supported');
    });

    it('does not show MCP config alert when mcpAvailable is false', async () => {
      const operations = createMockOperations();
      operations.getMcpConfigInfo = vi.fn().mockResolvedValue({ exists: false, path: '/test' });

      render(<UnifiedToolsSettings mcpAvailable={false} operations={operations} />);

      await waitFor(() => {
        expect(screen.queryByTestId('mcp-config-alert')).not.toBeInTheDocument();
      });
    });

    it('shows MCP config alert when config is missing', async () => {
      const operations = createMockOperations();
      operations.getMcpConfigInfo = vi.fn().mockResolvedValue({ exists: false, path: '/test' });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('mcp-config-alert')).toBeInTheDocument();
      });
    });

    it('shows sample config creation errors from the missing-config alert', async () => {
      const operations = createMockOperations();
      operations.getMcpConfigInfo = vi.fn().mockResolvedValue({ exists: false, path: '/test' });
      operations.createSampleConfig = vi.fn().mockResolvedValue({
        error: 'template write failed',
        success: false,
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
      operations.getMcpConfigInfo = vi.fn().mockResolvedValue({ exists: false, path: '/test' });

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
        .mockResolvedValue({ revision: 1, servers: [connectedMcpStatus] });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('connection-status-mcp-github')).toHaveTextContent('connected');
      });
    });

    it('surfaces a missing live host-status subscription capability', async () => {
      const operations = createMockOperations();
      operations.getMcpServerStatus = vi
        .fn()
        .mockResolvedValue({ revision: 1, servers: [connectedMcpStatus] });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      expect(
        await screen.findByText('MCP live status subscription is unavailable in this runtime.')
      ).toBeInTheDocument();
    });

    it('surfaces a tool-group identity that has no matching host status', async () => {
      const operations = createMockOperations();
      operations.getMcpServerStatus = vi.fn().mockResolvedValue({
        revision: 1,
        servers: [
          {
            ...connectedMcpStatus,
            configuredServerId: parseConfiguredMcpServerId('different-server'),
          },
        ],
      });
      operations.subscribeMcpServerStatus = vi.fn(() => vi.fn());

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      expect(
        await screen.findByText('MCP tool projection server "github" has no matching host status.')
      ).toBeInTheDocument();
    });

    it('keeps the host-status subscription when only the operations object identity changes', async () => {
      const operations = createMockOperations();
      const dispose = vi.fn();
      operations.getMcpServerStatus = vi
        .fn()
        .mockResolvedValue({ revision: 1, servers: [connectedMcpStatus] });
      operations.subscribeMcpServerStatus = vi.fn(() => dispose);
      const view = render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);
      await waitFor(() => expect(operations.subscribeMcpServerStatus).toHaveBeenCalledOnce());

      await act(async () => {
        view.rerender(<UnifiedToolsSettings mcpAvailable={true} operations={{ ...operations }} />);
      });

      expect(operations.subscribeMcpServerStatus).toHaveBeenCalledOnce();
      expect(dispose).not.toHaveBeenCalled();

      view.unmount();
      expect(dispose).toHaveBeenCalledOnce();
    });

    it('shows a connected zero-tool server with negotiated facts', async () => {
      const operations = createMockOperations();
      operations.getTools = vi.fn().mockResolvedValue([]);
      operations.getMcpConfigInfo = vi.fn().mockResolvedValue({ exists: true, path: '/test' });
      operations.getMcpServerStatus = vi
        .fn()
        .mockResolvedValue({ revision: 1, servers: [connectedMcpStatus] });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      const statusList = await screen.findByTestId('mcp-server-status-list');
      expect(statusList).toHaveTextContent('github');
      expect(statusList).toHaveTextContent('era modern · revision 2026-07-28');
      expect(statusList).toHaveTextContent('github-server 2.0.0');
      expect(statusList).toHaveTextContent('capabilities: tools');
    });

    it('renders zero-tool lifecycle failures, diagnostics, and capability-wired controls', async () => {
      const operations = createMockOperations();
      operations.getTools = vi.fn().mockResolvedValue([]);
      operations.getMcpServerStatus = vi.fn().mockResolvedValue({
        revision: 4,
        servers: [
          {
            configuredProtocol: 'legacy',
            configuredServerId: parseConfiguredMcpServerId('auth-server'),
            generation: 1,
            state: 'authentication-required',
            transport: 'stdio',
          },
          {
            configuredProtocol: 'legacy',
            configuredServerId: parseConfiguredMcpServerId('connecting-server'),
            generation: 1,
            state: 'authorizing',
            transport: 'stdio',
          },
          {
            configuredProtocol: 'legacy',
            configuredServerId: parseConfiguredMcpServerId('failed-server'),
            diagnostics: [{ message: 'stderr is safe', stream: 'stderr', truncated: false }],
            error: {
              category: 'connection',
              code: 'mcp-connection-failed',
              message: 'MCP server connection failed',
            },
            generation: 1,
            state: 'error',
            transport: 'stdio',
          },
        ],
      });
      operations.controlMcpServer = vi.fn().mockResolvedValue({ revision: 4, servers: [] });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      const statusList = await screen.findByTestId('mcp-server-status-list');
      expect(statusList).toHaveTextContent('stderr · stderr is safe');
      expect(screen.getByTestId('mcp-connect-auth-server')).toBeInTheDocument();
      expect(screen.getByTestId('mcp-cancel-connecting-server')).toBeInTheDocument();
      expect(screen.getByTestId('mcp-retry-failed-server')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('mcp-cancel-connecting-server'));
      await waitFor(() =>
        expect(operations.controlMcpServer).toHaveBeenCalledWith({
          action: 'cancel',
          configuredServerId: parseConfiguredMcpServerId('connecting-server'),
        })
      );
    });

    it('renders accessible token-free OAuth policy and destructive controls', async () => {
      const operations = createMockOperations();
      operations.getTools = vi.fn().mockResolvedValue([]);
      operations.getMcpServerStatus = vi.fn().mockResolvedValue({
        revision: 5,
        servers: [
          {
            auth: {
              credentialState: 'missing',
              grantedScopes: [],
              requestedScopes: ['read'],
              resourceUrl: 'https://mcp.linear.app/mcp/readonly',
              type: 'oauth-user',
            },
            configuredProtocol: 'auto',
            configuredServerId: parseConfiguredMcpServerId('linear-read'),
            generation: 1,
            state: 'authentication-required',
            transport: 'streamable-http',
          },
          {
            auth: {
              authorizationServer: 'https://linear.app',
              credentialSecretSentinel: 'private-secret-sentinel',
              credentialState: 'stored',
              grantedScopes: ['read', 'write'],
              lastSuccessfulConnectionAt: Date.parse('2026-08-31T12:00:00.000Z'),
              requestedScopes: ['read', 'write'],
              resourceUrl: 'https://mcp.linear.app/mcp',
              type: 'oauth-user',
            } as never,
            configuredProtocol: 'auto',
            configuredServerId: parseConfiguredMcpServerId('linear-write'),
            generation: 2,
            negotiated: {
              advertisedCapabilityIds: ['tools'],
              era: 'modern',
              revision: '2026-07-28',
            },
            state: 'connected',
            transport: 'streamable-http',
          },
          {
            auth: {
              credentialState: 'stored',
              grantedScopes: [],
              requestedScopes: [],
              resourceUrl: 'https://mcp.example.test/mcp',
              type: 'oauth-user',
            },
            configuredProtocol: 'auto',
            configuredServerId: parseConfiguredMcpServerId('oauth-error'),
            error: {
              category: 'authentication',
              code: 'mcp-authentication-failed',
              message: 'MCP server requires authentication',
            },
            generation: 2,
            state: 'error',
            transport: 'streamable-http',
          },
          {
            auth: {
              credentialState: 'stored',
              grantedScopes: ['read'],
              requestedScopes: ['read'],
              resourceUrl: 'https://mcp.example.test/mcp',
              type: 'oauth-user',
            },
            configuredProtocol: 'auto',
            configuredServerId: parseConfiguredMcpServerId('oauth-stored'),
            generation: 2,
            state: 'authentication-required',
            transport: 'streamable-http',
          },
          {
            auth: {
              credentialState: 'stored',
              grantedScopes: ['read'],
              requestedScopes: ['read'],
              resourceUrl: 'https://mcp.example.test/mcp',
              type: 'oauth-user',
            },
            configuredProtocol: 'auto',
            configuredServerId: parseConfiguredMcpServerId('oauth-transport-error'),
            error: {
              category: 'transport',
              code: 'mcp-transport-failed',
              message: 'Network unavailable',
            },
            generation: 2,
            state: 'error',
            transport: 'streamable-http',
          },
          {
            auth: {
              credentialState: 'unreadable',
              grantedScopes: [],
              requestedScopes: ['read'],
              resourceUrl: 'https://mcp.example.test/mcp',
              type: 'oauth-user',
            },
            configuredProtocol: 'auto',
            configuredServerId: parseConfiguredMcpServerId('oauth-unreadable'),
            generation: 2,
            state: 'authentication-required',
            transport: 'streamable-http',
          },
          {
            auth: {
              credentialState: 'stored',
              grantedScopes: ['read'],
              lastSuccessfulConnectionAt: Number.NaN,
              requestedScopes: ['read'],
              resourceUrl: 'https://mcp.example.test/mcp',
              type: 'oauth-user',
            },
            configuredProtocol: 'auto',
            configuredServerId: parseConfiguredMcpServerId('oauth-invalid-time'),
            generation: 2,
            negotiated: { era: 'modern', revision: '2026-07-28' },
            state: 'connected',
            transport: 'streamable-http',
          },
        ],
      });
      operations.controlMcpServer = vi.fn().mockResolvedValue({
        configuredProtocol: 'auto',
        configuredServerId: parseConfiguredMcpServerId('linear-write'),
        generation: 3,
        state: 'authentication-required',
        transport: 'streamable-http',
      });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      const statusList = await screen.findByTestId('mcp-server-status-list');
      expect(statusList).toHaveTextContent('Requested scopes: read');
      expect(statusList).toHaveTextContent('Granted scopes: read, write');
      expect(statusList).toHaveTextContent('https://mcp.linear.app/mcp/readonly');
      expect(statusList).toHaveTextContent('OAuth credentials stored');
      expect(statusList).toHaveTextContent('OAuth credentials unreadable');
      expect(statusList).toHaveTextContent('invalid stored timestamp');
      expect(statusList).not.toHaveTextContent(
        /access-token|refresh-token|private-secret|private-secret-sentinel/u
      );
      expect(screen.getByRole('button', { name: 'Connect linear-read' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Disconnect linear-write' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Reauthorize linear-write' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Reauthorize oauth-error' })).toBeInTheDocument();
      expect(screen.queryByTestId('mcp-retry-oauth-error')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Connect oauth-stored' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Disconnect oauth-stored' })).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Retry oauth-transport-error' })
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Disconnect oauth-transport-error' })
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Disconnect oauth-unreadable' })
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Connect oauth-unreadable' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Reauthorize linear-write' }));
      expect(await screen.findByRole('dialog')).toHaveTextContent(
        'Its stored OAuth credentials will be cleared before a new authorization flow opens.'
      );
      fireEvent.click(screen.getByRole('button', { name: 'Confirm reauthorize linear-write' }));
      await waitFor(() =>
        expect(operations.controlMcpServer).toHaveBeenCalledWith({
          action: 'reauthorize',
          configuredServerId: parseConfiguredMcpServerId('linear-write'),
        })
      );
    });

    it('renders bearer credential availability without reference or secret material', async () => {
      const operations = createMockOperations();
      operations.getTools = vi.fn().mockResolvedValue([]);
      operations.getMcpServerStatus = vi.fn().mockResolvedValue({
        revision: 6,
        servers: (['stored', 'missing', 'unreadable', 'malformed'] as const).map(
          (credentialState, index) => ({
            auth: {
              credentialState,
              secretSentinel: 'bearer-secret-must-not-render',
              type: 'bearer' as const,
            },
            configuredProtocol: 'auto' as const,
            configuredServerId: parseConfiguredMcpServerId(`bearer-${credentialState}`),
            generation: index + 1,
            state: 'disconnected' as const,
            transport: 'streamable-http' as const,
          })
        ),
      });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      const statusList = await screen.findByTestId('mcp-server-status-list');
      expect(statusList).toHaveTextContent('Bearer credential stored');
      expect(statusList).toHaveTextContent('Bearer credential not stored');
      expect(statusList).toHaveTextContent('Bearer credential unreadable');
      expect(statusList).toHaveTextContent('Bearer credential malformed');
      expect(statusList).not.toHaveTextContent('bearer-secret-must-not-render');
    });

    it('does not run credential-destructive OAuth controls when confirmation is declined', async () => {
      const operations = createMockOperations();
      const server: McpHostServerSnapshot = {
        auth: {
          credentialState: 'stored',
          grantedScopes: ['read'],
          requestedScopes: ['read'],
          resourceUrl: 'https://mcp.linear.app/mcp/readonly',
          type: 'oauth-user',
        },
        configuredProtocol: 'auto',
        configuredServerId: parseConfiguredMcpServerId('linear'),
        generation: 2,
        negotiated: { era: 'modern', revision: '2026-07-28' },
        state: 'connected',
        transport: 'streamable-http',
      };
      operations.getTools = vi.fn().mockResolvedValue([]);
      operations.getMcpServerStatus = vi.fn().mockResolvedValue({ revision: 5, servers: [server] });
      operations.controlMcpServer = vi.fn().mockResolvedValue(server);

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Disconnect linear' }));

      expect(await screen.findByRole('dialog')).toHaveTextContent(
        'Disconnect linear and remove its stored OAuth credentials?'
      );
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(operations.controlMcpServer).not.toHaveBeenCalled();
    });

    it('deduplicates pending lifecycle controls and disables sibling actions', async () => {
      const operations = createMockOperations();
      const pending = Promise.withResolvers<McpHostServerSnapshot>();
      const server: McpHostServerSnapshot = {
        auth: {
          credentialState: 'stored',
          grantedScopes: ['read'],
          requestedScopes: ['read'],
          resourceUrl: 'https://mcp.linear.app/mcp',
          type: 'oauth-user',
        },
        configuredProtocol: 'auto',
        configuredServerId: parseConfiguredMcpServerId('linear'),
        generation: 2,
        negotiated: { era: 'modern', revision: '2026-07-28' },
        state: 'connected',
        transport: 'streamable-http',
      };
      operations.getTools = vi.fn().mockResolvedValue([]);
      operations.getMcpServerStatus = vi.fn().mockResolvedValue({ revision: 5, servers: [server] });
      operations.controlMcpServer = vi.fn(async () => await pending.promise);

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);
      const reauthorize = await screen.findByRole('button', { name: 'Reauthorize linear' });
      const disconnect = screen.getByRole('button', { name: 'Disconnect linear' });
      fireEvent.click(reauthorize);
      fireEvent.click(screen.getByRole('button', { name: 'Confirm reauthorize linear' }));

      expect(operations.controlMcpServer).toHaveBeenCalledOnce();
      expect(reauthorize).toBeDisabled();
      expect(disconnect).toBeDisabled();

      pending.resolve(server);
      await waitFor(() => expect(reauthorize).toBeEnabled());
    });

    it('keeps cancellation available while a user-paced connection is pending', async () => {
      const operations = createMockOperations();
      const connect = Promise.withResolvers<McpHostServerSnapshot>();
      let publish: ((snapshot: McpHostSnapshot) => void) | undefined;
      const serverId = parseConfiguredMcpServerId('linear');
      operations.getTools = vi.fn().mockResolvedValue([]);
      operations.getMcpServerStatus = vi.fn().mockResolvedValue({
        revision: 1,
        servers: [
          {
            configuredProtocol: '2026-07-28',
            configuredServerId: serverId,
            generation: 1,
            state: 'authentication-required',
            transport: 'streamable-http',
          },
        ],
      });
      operations.subscribeMcpServerStatus = vi.fn((listener) => {
        publish = listener;
        return vi.fn();
      });
      const cancelled: McpHostServerSnapshot = {
        configuredProtocol: '2026-07-28',
        configuredServerId: serverId,
        generation: 1,
        state: 'disconnected',
        transport: 'streamable-http',
      };
      operations.controlMcpServer = vi.fn(async (request) => {
        if (request.action === 'connect') {
          return await connect.promise;
        }
        return cancelled;
      });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Connect linear' }));
      act(() => {
        publish?.({
          revision: 2,
          servers: [
            {
              configuredProtocol: '2026-07-28',
              configuredServerId: serverId,
              generation: 1,
              state: 'connecting',
              transport: 'streamable-http',
            },
          ],
        });
      });
      const cancel = await screen.findByRole('button', { name: 'Cancel linear' });
      expect(cancel).toBeEnabled();
      fireEvent.click(cancel);
      fireEvent.click(cancel);
      await waitFor(() =>
        expect(operations.controlMcpServer).toHaveBeenCalledWith({
          action: 'cancel',
          configuredServerId: serverId,
        })
      );
      expect(operations.controlMcpServer).toHaveBeenCalledTimes(2);
      await act(async () => {
        connect.reject(new Error('cancelled'));
        await connect.promise.catch(() => undefined);
      });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('renders lifecycle-control rejections and re-enables controls', async () => {
      const operations = createMockOperations();
      operations.getTools = vi.fn().mockResolvedValue([]);
      operations.getMcpServerStatus = vi.fn().mockResolvedValue({
        revision: 5,
        servers: [
          {
            auth: {
              credentialState: 'missing',
              grantedScopes: [],
              requestedScopes: ['read'],
              resourceUrl: 'https://mcp.linear.app/mcp/readonly',
              type: 'oauth-user',
            },
            configuredProtocol: 'auto',
            configuredServerId: parseConfiguredMcpServerId('linear'),
            generation: 1,
            state: 'authentication-required',
            transport: 'streamable-http',
          },
        ],
      });
      operations.controlMcpServer = vi.fn().mockRejectedValue(new Error('authorization denied'));

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);
      const connect = await screen.findByRole('button', { name: 'Connect linear' });
      fireEvent.click(connect);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'MCP lifecycle control failed: authorization denied'
      );
      expect(connect).toBeEnabled();
    });

    it('shows core feature support, browsable catalogs, and catalog errors independently of tools', async () => {
      const operations = createMockOperations();
      operations.getTools = vi.fn().mockResolvedValue([]);
      operations.getMcpServerStatus = vi.fn().mockResolvedValue({
        revision: 1,
        servers: [
          {
            ...connectedMcpStatus,
            catalog: {
              errors: {
                prompts: {
                  category: 'operation',
                  code: 'mcp-prompts-failed',
                  message: 'MCP catalog operation failed',
                },
              },
              features: {
                completion: true,
                promptListChanged: true,
                prompts: true,
                resourceListChanged: true,
                resourceSubscriptions: true,
                resources: true,
                toolListChanged: false,
                tools: true,
              },
              prompts: { prompts: [{ name: 'fallback-prompt', title: '   ' }] },
              resources: {
                resources: Array.from({ length: 7 }, (_, index) => ({
                  name: `BST-${1471 + index}`,
                  uri: `linear://issue/BST-${1471 + index}`,
                })),
              },
              resourceTemplates: {
                resourceTemplates: [{ name: 'issue', uriTemplate: 'linear://issue/{identifier}' }],
              },
              subscription: {
                honoredFilter: {
                  promptsListChanged: true,
                  resourceSubscriptions: Array.from(
                    { length: 7 },
                    (_, index) => `linear://issue/subscription-${index + 1}`
                  ),
                  resourcesListChanged: true,
                },
                mode: 'modern-listen',
                state: 'listening',
              },
              tools: {
                tools: [{ inputSchema: { type: 'object' }, name: 'issue_lookup', title: '  ' }],
              },
            },
          },
        ],
      });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      const catalog = await screen.findByTestId('mcp-server-catalog-github');
      expect(catalog).toHaveTextContent('Resources Supported');
      expect(catalog).toHaveTextContent('Prompts Supported');
      expect(catalog).toHaveTextContent('Completion Supported');
      expect(catalog).toHaveTextContent('Resource subscriptions Supported');
      expect(catalog).toHaveTextContent('Resource list changes Supported');
      expect(catalog).toHaveTextContent('Prompt list changes Supported');
      expect(catalog).toHaveTextContent('Tool list changes Unsupported');
      expect(catalog).toHaveTextContent('Resources (showing 5 of 7)');
      expect(catalog).toHaveTextContent('BST-1471');
      expect(catalog).not.toHaveTextContent('BST-1477');
      expect(catalog).toHaveTextContent('linear://issue/{identifier}');
      expect(catalog).toHaveTextContent('fallback-prompt');
      expect(catalog).toHaveTextContent('issue_lookup');
      expect(catalog).toHaveTextContent('modern-listen · listening');
      expect(catalog).toHaveTextContent('resource subscriptions 7');
      expect(catalog).toHaveTextContent('Honored resource subscriptions (showing 5 of 7)');
      expect(catalog).not.toHaveTextContent('linear://issue/subscription-7');
      expect(catalog).toHaveTextContent('mcp-prompts-failed');
      // Without content operations (web), no browsing affordance renders at all.
      expect(within(catalog).queryByTestId('mcp-catalog-read-github-0')).not.toBeInTheDocument();
      expect(within(catalog).queryByTestId('mcp-catalog-prompt-github-0')).not.toBeInTheDocument();
      expect(within(catalog).queryByRole('button')).not.toBeInTheDocument();
    });

    describe('user-initiated content browsing (BST-1585)', () => {
      const authority = { configuredServerId: 'github', generation: 1 };
      const longText = 'x'.repeat(2500);
      const browsableCatalog = {
        errors: {},
        features: {
          completion: true,
          promptListChanged: false,
          prompts: true,
          resourceListChanged: false,
          resourceSubscriptions: false,
          resources: true,
          toolListChanged: false,
          tools: true,
        },
        prompts: {
          prompts: [
            {
              arguments: [
                { description: 'Issue identifier', name: 'identifier', required: true },
                { name: 'tone' },
              ],
              name: 'issue-summary',
              title: 'Issue summary',
            },
            { name: 'plain-prompt' },
          ],
        },
        resources: { resources: [{ name: 'BST-1585', uri: 'linear://issue/BST-1585' }] },
        subscription: { mode: 'none', state: 'unsupported' },
        tools: { tools: [] },
      };
      const createContentOperations = (): ToolsSettingsOperations => {
        const operations = createMockOperations();
        operations.getTools = vi.fn().mockResolvedValue([]);
        operations.getMcpServerStatus = vi.fn().mockResolvedValue({
          revision: 1,
          servers: [{ ...connectedMcpStatus, catalog: browsableCatalog }],
        });
        operations.readMcpResource = vi.fn().mockResolvedValue({
          result: {
            contents: [
              { mimeType: 'text/markdown', text: '# BST-1585', uri: 'linear://issue/BST-1585' },
              { blob: 'QUFBQQ==', mimeType: 'image/png', uri: 'linear://issue/BST-1585/cover' },
              { text: longText, uri: 'linear://issue/BST-1585/body' },
            ],
          },
          type: 'resources/read',
        });
        operations.getMcpPrompt = vi.fn().mockResolvedValue({
          result: {
            description: 'Summarize an issue',
            messages: [
              { content: { text: 'Summarize BST-1585', type: 'text' }, role: 'user' },
              { content: { data: 'QUFBQQ==', mimeType: 'image/png', type: 'image' }, role: 'user' },
            ],
          },
          type: 'prompts/get',
        });
        operations.completeMcpContent = vi.fn().mockResolvedValue({
          result: { completion: { values: ['BST-1585', 'BST-1586'] } },
          type: 'completion/complete',
        });
        return operations;
      };

      it('reads a resource only on explicit user action and renders bounded content', async () => {
        const operations = createContentOperations();
        render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

        const read = await screen.findByRole('button', { name: 'Read BST-1585' });
        expect(read).toHaveAttribute('data-testid', 'mcp-catalog-read-github-0');
        expect(operations.readMcpResource).not.toHaveBeenCalled();
        expect(screen.queryByTestId('mcp-catalog-content-github')).not.toBeInTheDocument();

        fireEvent.click(read);
        const content = await screen.findByTestId('mcp-catalog-content-github');
        expect(operations.readMcpResource).toHaveBeenCalledTimes(1);
        expect(operations.readMcpResource).toHaveBeenCalledWith({
          authority,
          uri: 'linear://issue/BST-1585',
        });
        expect(content).toHaveTextContent('Resource linear://issue/BST-1585');
        expect(content).toHaveTextContent('text/markdown');
        expect(content).toHaveTextContent('# BST-1585');
        expect(content).toHaveTextContent('image/png');
        expect(content).toHaveTextContent('binary content omitted (8 base64 characters)');
        expect(content).not.toHaveTextContent('QUFBQQ==');
        expect(content).toHaveTextContent('(truncated 500 characters)');
        expect(content.textContent?.length ?? 0).toBeLessThan(longText.length);
        expect(read).toBeEnabled();
      });

      it('collects prompt arguments with completion suggestions before fetching the prompt', async () => {
        const operations = createContentOperations();
        render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

        const plain = await screen.findByRole('button', { name: 'Use prompt plain-prompt' });
        expect(plain).toHaveAttribute('data-testid', 'mcp-catalog-prompt-github-1');
        fireEvent.click(plain);
        await screen.findByTestId('mcp-catalog-content-github');
        expect(operations.getMcpPrompt).toHaveBeenCalledWith({ authority, name: 'plain-prompt' });
        expect(screen.queryByTestId('mcp-catalog-prompt-form-github')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Use prompt Issue summary' }));
        const form = await screen.findByTestId('mcp-catalog-prompt-form-github');
        expect(form).toHaveTextContent('Issue identifier');
        const identifier = within(form).getByLabelText('identifier (required)');
        expect(identifier).toBeRequired();
        const tone = within(form).getByLabelText('tone');
        expect(tone).not.toBeRequired();

        fireEvent.change(identifier, { target: { value: 'BST' } });
        await waitFor(() =>
          expect(operations.completeMcpContent).toHaveBeenCalledWith({
            argument: { name: 'identifier', value: 'BST' },
            authority,
            ref: { name: 'issue-summary', type: 'ref/prompt' },
          })
        );
        await waitFor(() => expect(form.querySelectorAll('datalist option')).toHaveLength(2));
        expect(identifier).toHaveAttribute('list');
        expect(form.querySelector('datalist option')).toHaveAttribute('value', 'BST-1585');

        fireEvent.change(tone, { target: { value: 'friendly' } });
        await waitFor(() =>
          expect(operations.completeMcpContent).toHaveBeenLastCalledWith({
            argument: { name: 'tone', value: 'friendly' },
            authority,
            context: { arguments: { identifier: 'BST' } },
            ref: { name: 'issue-summary', type: 'ref/prompt' },
          })
        );

        fireEvent.submit(form);
        await waitFor(() =>
          expect(operations.getMcpPrompt).toHaveBeenLastCalledWith({
            arguments: { identifier: 'BST', tone: 'friendly' },
            authority,
            name: 'issue-summary',
          })
        );
        const content = await screen.findByTestId('mcp-catalog-content-github');
        await waitFor(() => expect(content).toHaveTextContent('Prompt issue-summary'));
        expect(content).toHaveTextContent('Summarize an issue');
        expect(content).toHaveTextContent('Summarize BST-1585');
        expect(content).toHaveTextContent('image content omitted');
        expect(content).not.toHaveTextContent('QUFBQQ==');
      });

      it('honors required prompt arguments before issuing prompts/get', async () => {
        const operations = createContentOperations();
        render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

        fireEvent.click(await screen.findByRole('button', { name: 'Use prompt Issue summary' }));
        const form = await screen.findByTestId('mcp-catalog-prompt-form-github');
        fireEvent.submit(form);

        expect(await screen.findByRole('alert')).toHaveTextContent(
          'Prompt argument identifier is required'
        );
        expect(operations.getMcpPrompt).not.toHaveBeenCalled();
      });

      it('surfaces content failures without leaving the affordance stuck', async () => {
        const operations = createContentOperations();
        operations.readMcpResource = vi
          .fn()
          .mockRejectedValue(
            new Error(
              'MCP content server not connected (not-connected · mcp_content_server_not_connected)'
            )
          );
        render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

        const read = await screen.findByRole('button', { name: 'Read BST-1585' });
        fireEvent.click(read);

        expect(await screen.findByRole('alert')).toHaveTextContent(
          'MCP content request failed: MCP content server not connected (not-connected · mcp_content_server_not_connected)'
        );
        expect(screen.queryByTestId('mcp-catalog-content-github')).not.toBeInTheDocument();
        expect(read).toBeEnabled();
      });

      it('debounces completion, skips empty input, dedupes values, and gates on the capability', async () => {
        const operations = createContentOperations();
        operations.completeMcpContent = vi.fn().mockResolvedValue({
          result: { completion: { values: ['BST-1585', 'BST-1585', 'BST-1586'] } },
          type: 'completion/complete',
        });
        render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Use prompt Issue summary' }));
        const form = await screen.findByTestId('mcp-catalog-prompt-form-github');
        const identifier = within(form).getByLabelText('identifier (required)');

        fireEvent.change(identifier, { target: { value: 'B' } });
        fireEvent.change(identifier, { target: { value: 'BS' } });
        fireEvent.change(identifier, { target: { value: 'BST' } });
        await waitFor(() => expect(operations.completeMcpContent).toHaveBeenCalledTimes(1));
        expect(operations.completeMcpContent).toHaveBeenCalledWith(
          expect.objectContaining({ argument: { name: 'identifier', value: 'BST' } })
        );
        await waitFor(() => expect(form.querySelectorAll('datalist option')).toHaveLength(2));

        fireEvent.change(identifier, { target: { value: '' } });
        await waitFor(() => expect(identifier).not.toHaveAttribute('list'));
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(operations.completeMcpContent).toHaveBeenCalledTimes(1);
      });

      it('never requests completion from a server that does not advertise it', async () => {
        const operations = createContentOperations();
        operations.getMcpServerStatus = vi.fn().mockResolvedValue({
          revision: 1,
          servers: [
            {
              ...connectedMcpStatus,
              catalog: {
                ...browsableCatalog,
                features: { ...browsableCatalog.features, completion: false },
              },
            },
          ],
        });
        render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Use prompt Issue summary' }));
        const form = await screen.findByTestId('mcp-catalog-prompt-form-github');
        const identifier = within(form).getByLabelText('identifier (required)');

        fireEvent.change(identifier, { target: { value: 'BST' } });
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(operations.completeMcpContent).not.toHaveBeenCalled();
        expect(identifier).not.toHaveAttribute('list');
        expect(form.querySelector('datalist')).toBeNull();
      });

      it('bounds rendered contents and messages to a fixed item count', async () => {
        const operations = createContentOperations();
        operations.readMcpResource = vi.fn().mockResolvedValue({
          result: {
            contents: Array.from({ length: 25 }, (_, index) => ({
              text: `part ${index}`,
              uri: `linear://issue/BST-1585/part-${index}`,
            })),
          },
          type: 'resources/read',
        });
        render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

        fireEvent.click(await screen.findByRole('button', { name: 'Read BST-1585' }));
        const content = await screen.findByTestId('mcp-catalog-content-github');
        expect(content).toHaveTextContent('Contents (showing 20 of 25)');
        expect(content.querySelectorAll('pre')).toHaveLength(20);
        expect(content).toHaveTextContent('part 19');
        expect(content).not.toHaveTextContent('part 20');
      });

      it('clears the required-argument message on cancel and keeps it out of the request wrapper', async () => {
        const operations = createContentOperations();
        render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

        fireEvent.click(await screen.findByRole('button', { name: 'Use prompt Issue summary' }));
        const form = await screen.findByTestId('mcp-catalog-prompt-form-github');
        fireEvent.submit(form);
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('Prompt argument identifier is required');
        expect(alert).not.toHaveTextContent('MCP content request failed');

        fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(screen.queryByTestId('mcp-catalog-prompt-form-github')).not.toBeInTheDocument();
      });

      it('discards browsed content when the server generation changes', async () => {
        const operations = createContentOperations();
        operations.getMcpServerStatus = vi
          .fn()
          .mockResolvedValueOnce({
            revision: 1,
            servers: [{ ...connectedMcpStatus, catalog: browsableCatalog }],
          })
          .mockResolvedValue({
            revision: 2,
            servers: [{ ...connectedMcpStatus, catalog: browsableCatalog, generation: 2 }],
          });
        const view = render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

        fireEvent.click(await screen.findByRole('button', { name: 'Read BST-1585' }));
        await screen.findByTestId('mcp-catalog-content-github');

        await act(async () => {
          view.rerender(
            <UnifiedToolsSettings mcpAvailable={true} operations={{ ...operations }} />
          );
        });

        await waitFor(() => expect(operations.getMcpServerStatus).toHaveBeenCalledTimes(2));
        await waitFor(() =>
          expect(screen.queryByTestId('mcp-catalog-content-github')).not.toBeInTheDocument()
        );
        expect(await screen.findByRole('button', { name: 'Read BST-1585' })).toBeEnabled();
        expect(operations.readMcpResource).toHaveBeenCalledTimes(1);
      });
    });

    it('distinguishes an explicit empty host snapshot from a malformed config', async () => {
      const operations = createMockOperations();
      operations.getTools = vi.fn().mockResolvedValue([]);
      operations.getMcpServerStatus = vi.fn().mockResolvedValue({ revision: 1, servers: [] });
      operations.getMcpConfigInfo = vi
        .fn()
        .mockResolvedValue({ error: 'invalid_mcp_config', exists: true, path: '/test' });

      const view = render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);
      expect(await screen.findByText('invalid_mcp_config')).toBeInTheDocument();
      expect(screen.queryByTestId('mcp-server-status-empty')).not.toBeInTheDocument();

      view.unmount();
      const validOperations = createMockOperations();
      validOperations.getTools = vi.fn().mockResolvedValue([]);
      validOperations.getMcpServerStatus = vi.fn().mockResolvedValue({ revision: 1, servers: [] });
      validOperations.getMcpConfigInfo = vi.fn().mockResolvedValue({ exists: true, path: '/test' });
      render(<UnifiedToolsSettings mcpAvailable={true} operations={validOperations} />);
      expect(await screen.findByTestId('mcp-server-status-empty')).toHaveTextContent(
        'No MCP servers configured.'
      );
    });

    it('renders core support separately from every official MCP extension', async () => {
      const operations = createMockOperations();

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      const matrix = await screen.findByTestId('mcp-support-matrix');
      expect(within(matrix).getAllByTestId(/^mcp-support-row-/u)).toHaveLength(7);
      const expectedRows = [
        ['core:2026-07-28-tools', 'supported', 'BST-1463'],
        ['core:server-features', 'supported', 'BST-1471'],
        ['core:elicitation', 'supported', 'BST-1584'],
        ['io.modelcontextprotocol/ui', 'supported', 'BST-1572'],
        ['io.modelcontextprotocol/tasks', 'supported', 'BST-1566'],
        ['io.modelcontextprotocol/oauth-client-credentials', 'unsupported', ''],
        ['io.modelcontextprotocol/enterprise-managed-authorization', 'unsupported', ''],
      ] as const;
      for (const [id, status, implementationTicket] of expectedRows) {
        const row = within(matrix).getByTestId(`mcp-support-row-${id}`);
        expect(row).toHaveAttribute('data-status', status);
        expect(row).toHaveAttribute('data-implementation-ticket', implementationTicket);
        expect(within(row).getByTestId(`mcp-support-status-${id}`)).toHaveTextContent(
          status === 'supported' ? 'Supported' : 'Unsupported'
        );
      }
      expect(matrix).not.toHaveTextContent(/BST-|implementation ticket/u);
      expect(within(matrix).getByTestId('mcp-support-status-core:2026-07-28-tools')).toHaveClass(
        'text-success'
      );
      for (const gate of [
        'MIME declaration',
        'ui:// resource loading',
        'tool/result association',
        'sandbox/CSP',
        'bidirectional validation',
        'permission/consent',
        'lifecycle cleanup',
        'renderer tests',
      ]) {
        expect(matrix).toHaveTextContent(gate);
      }
    });

    it('shows structured errors in the accordion and diagnostic row for a failed server', async () => {
      const operations = createMockOperations();
      operations.getTools = vi.fn().mockResolvedValue(mockTools);
      operations.getMcpServerStatus = vi.fn().mockResolvedValue({
        revision: 3,
        servers: [
          {
            configuredProtocol: 'auto',
            configuredServerId: parseConfiguredMcpServerId('github'),
            error: {
              category: 'connection',
              code: 'mcp-transport-operation-failed',
              message: 'MCP server actor operation failed',
            },
            generation: 2,
            state: 'error',
            transport: 'streamable-http',
          },
        ],
      });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      const statusList = await screen.findByTestId('mcp-server-status-list');
      expect(screen.getByTestId('connection-status-mcp-github')).toHaveTextContent('error');
      expect(statusList).toHaveTextContent('github');
      expect(statusList).toHaveTextContent('connection · mcp-transport-operation-failed');
      expect(statusList).toHaveTextContent('MCP server actor operation failed');
    });

    it('opens the MCP config from an MCP group header action', async () => {
      const operations = createMockOperations();
      operations.openMcpConfig = vi.fn().mockResolvedValue(undefined);
      operations.getMcpServerStatus = vi.fn().mockResolvedValue({
        revision: 1,
        servers: [
          {
            configuredProtocol: 'legacy',
            configuredServerId: parseConfiguredMcpServerId('github'),
            generation: 1,
            state: 'disconnected',
            transport: 'stdio',
          },
        ],
      });

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
        .mockResolvedValueOnce({ revision: 1, servers: [connectedMcpStatus] })
        .mockResolvedValue({ revision: 1, servers: [connectedMcpStatus] });
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

    it('clears a recovered MCP status error without a config-info operation', async () => {
      const operations = createMockOperations();
      operations.getMcpServerStatus = vi
        .fn()
        .mockRejectedValueOnce(new Error('MCP down without config info'))
        .mockResolvedValueOnce({ revision: 1, servers: [connectedMcpStatus] })
        .mockResolvedValue({ revision: 1, servers: [connectedMcpStatus] });
      operations.subscribeMcpServerStatus = vi.fn(() => vi.fn());

      const view = render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);
      expect(await screen.findByText('MCP down without config info')).toBeInTheDocument();

      await act(async () => {
        view.rerender(<UnifiedToolsSettings mcpAvailable={true} operations={{ ...operations }} />);
      });

      await waitFor(() => expect(operations.getMcpServerStatus).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(screen.queryByText('MCP down without config info')).not.toBeInTheDocument()
      );
    });

    it('does not publish a rejection from a config read superseded by a watch event', async () => {
      const staleRead = Promise.withResolvers<McpConfigInfo | null>();
      let publishConfig: ((info: McpConfigInfo) => void) | undefined;
      const operations = createMockOperations();
      operations.getMcpConfigInfo = vi.fn(async () => await staleRead.promise);
      operations.subscribeMcpConfig = vi.fn((listener) => {
        publishConfig = listener;
        return vi.fn();
      });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);
      await waitFor(() => expect(operations.getMcpConfigInfo).toHaveBeenCalledOnce());
      act(() => publishConfig?.({ exists: false, path: '/new-authority.json' }));
      expect(await screen.findByTestId('mcp-config-alert')).toBeInTheDocument();

      await act(async () => {
        staleRead.reject(new Error('stale config read failed'));
        await staleRead.promise.catch(() => undefined);
      });

      expect(screen.queryByText('stale config read failed')).not.toBeInTheDocument();
      expect(screen.getByTestId('mcp-config-alert')).toBeInTheDocument();
    });

    it('preserves accepted config authority while an error-boundary retry reload is pending', async () => {
      const retryStatus = Promise.withResolvers<McpHostSnapshot>();
      let publishStatus: ((snapshot: McpHostSnapshot) => void) | undefined;
      const operations = createMockOperations();
      operations.getMcpConfigInfo = vi
        .fn()
        .mockResolvedValue({ exists: false, path: '/accepted-config.json' });
      operations.getMcpServerStatus = vi
        .fn()
        .mockResolvedValueOnce({ revision: 1, servers: [connectedMcpStatus] })
        .mockImplementationOnce(async () => await retryStatus.promise)
        .mockResolvedValue({ revision: 3, servers: [connectedMcpStatus] });
      operations.subscribeMcpServerStatus = vi.fn((listener) => {
        publishStatus = listener;
        return vi.fn();
      });
      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);
      expect(await screen.findByTestId('mcp-config-alert')).toBeInTheDocument();

      ToolGroupAccordionMock.mockImplementation(() => {
        throw new Error('Crash after config authority');
      });
      try {
        act(() => publishStatus?.({ revision: 2, servers: [connectedMcpStatus] }));
        expect(await screen.findByTestId('tools-error-fallback')).toBeInTheDocument();
      } finally {
        ToolGroupAccordionMock.mockImplementation(renderToolGroupAccordion);
      }
      fireEvent.click(screen.getByRole('button', { name: /retry/i }));

      expect(screen.getByTestId('mcp-config-alert')).toBeInTheDocument();
      await act(async () => {
        retryStatus.resolve({ revision: 3, servers: [connectedMcpStatus] });
        await retryStatus.promise;
      });
    });

    it('rejects a stale initial snapshot after a newer watch revision', async () => {
      const operations = createMockOperations();
      const initial = Promise.withResolvers<McpHostSnapshot>();
      let publish: ((snapshot: McpHostSnapshot) => void) | undefined;
      operations.getTools = vi.fn().mockResolvedValue([]);
      operations.getMcpServerStatus = vi.fn(async () => await initial.promise);
      operations.subscribeMcpServerStatus = vi.fn((listener) => {
        publish = listener;
        return vi.fn();
      });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);
      await waitFor(() => expect(operations.subscribeMcpServerStatus).toHaveBeenCalledOnce());
      act(() => {
        publish?.({
          revision: 2,
          servers: [
            {
              configuredProtocol: 'auto',
              configuredServerId: parseConfiguredMcpServerId('newer'),
              generation: 2,
              state: 'connecting',
              transport: 'streamable-http',
            },
          ],
        });
      });
      expect(await screen.findByTestId('mcp-server-status-list')).toHaveTextContent('newer');

      await act(async () => {
        initial.resolve({
          revision: 1,
          servers: [
            {
              ...connectedMcpStatus,
              configuredServerId: parseConfiguredMcpServerId('stale'),
            },
          ],
        });
        await initial.promise;
      });

      await waitFor(() => {
        expect(screen.getByTestId('mcp-server-status-list')).toHaveTextContent('newer');
        expect(screen.getByTestId('mcp-server-status-list')).not.toHaveTextContent('stale');
      });
    });

    it('observes malformed config changes and recovery without a host revision', async () => {
      const operations = createMockOperations();
      let publishConfig: ((info: McpConfigInfo) => void) | undefined;
      operations.getTools = vi.fn().mockResolvedValue([]);
      operations.getMcpServerStatus = vi.fn().mockResolvedValue({ revision: 1, servers: [] });
      operations.getMcpConfigInfo = vi.fn().mockResolvedValue({ exists: true, path: '/test' });
      operations.subscribeMcpConfig = vi.fn((listener) => {
        publishConfig = listener;
        return vi.fn();
      });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);
      expect(await screen.findByTestId('mcp-server-status-empty')).toBeInTheDocument();
      act(() => publishConfig?.({ error: 'invalid JSON', exists: true, path: '/test' }));
      expect(await screen.findByText('invalid JSON')).toBeInTheDocument();
      expect(screen.queryByTestId('mcp-server-status-empty')).not.toBeInTheDocument();

      act(() => publishConfig?.({ exists: true, path: '/test' }));
      await waitFor(() => expect(screen.queryByText('invalid JSON')).not.toBeInTheDocument());
      expect(screen.getByTestId('mcp-server-status-empty')).toBeInTheDocument();
    });

    it('does not fabricate status and refreshes tools from projection events', async () => {
      const operations = createMockOperations();
      let publishTools: (() => void) | undefined;
      operations.getTools = vi
        .fn()
        .mockResolvedValueOnce(mockTools)
        .mockResolvedValueOnce(mockTools.filter(({ source }) => source === 'native'))
        .mockResolvedValue(mockTools.filter(({ source }) => source === 'native'));
      operations.getMcpServerStatus = vi.fn().mockResolvedValue({ revision: 1, servers: [] });
      operations.subscribeMcpTools = vi.fn((listener) => {
        publishTools = listener;
        return vi.fn();
      });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);
      expect(await screen.findByTestId('tool-group-mcp-github')).toBeInTheDocument();
      expect(screen.queryByTestId('connection-status-mcp-github')).not.toBeInTheDocument();

      act(() => publishTools?.());
      await waitFor(() =>
        expect(screen.queryByTestId('tool-group-mcp-github')).not.toBeInTheDocument()
      );
    });

    it('preserves the revision fence across an error-boundary retry', async () => {
      const operations = createMockOperations();
      const initial = Promise.withResolvers<McpHostSnapshot>();
      let publish: ((snapshot: McpHostSnapshot) => void) | undefined;
      operations.getMcpServerStatus = vi.fn(async () => await initial.promise);
      operations.subscribeMcpServerStatus = vi.fn((listener) => {
        publish = listener;
        return vi.fn();
      });
      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);
      await waitFor(() => expect(operations.subscribeMcpServerStatus).toHaveBeenCalledOnce());

      ToolGroupAccordionMock.mockImplementation(() => {
        throw new Error('Crash after status event');
      });
      try {
        act(() => {
          publish?.({
            revision: 2,
            servers: [
              { ...connectedMcpStatus, configuredServerId: parseConfiguredMcpServerId('newer') },
            ],
          });
        });
        expect(await screen.findByTestId('tools-error-fallback')).toBeInTheDocument();
      } finally {
        ToolGroupAccordionMock.mockImplementation(renderToolGroupAccordion);
      }
      fireEvent.click(screen.getByRole('button', { name: /retry/i }));

      await act(async () => {
        initial.resolve({
          revision: 1,
          servers: [
            { ...connectedMcpStatus, configuredServerId: parseConfiguredMcpServerId('stale') },
          ],
        });
        await initial.promise;
      });
      await waitFor(() => {
        expect(screen.getByTestId('mcp-server-status-list')).toHaveTextContent('newer');
        expect(screen.getByTestId('mcp-server-status-list')).not.toHaveTextContent('stale');
      });
    });

    it('loads MCP config editor content when editor operations are provided', async () => {
      const operations = createMockOperations();
      operations.readMcpConfigText = vi.fn().mockResolvedValue({
        content: '{\n  "servers": []\n}',
        created: false,
        exists: true,
        path: '/tmp/mcp.config.json',
      });
      operations.writeMcpConfigText = vi
        .fn()
        .mockResolvedValue({ path: '/tmp/mcp.config.json', success: true });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      await waitFor(() => {
        expect(operations.readMcpConfigText).toHaveBeenCalled();
      });

      expect(screen.getByTestId('mcp-config-editor')).toBeInTheDocument();
      expect(screen.getByTestId('mcp-config-path-input')).toHaveValue('/tmp/mcp.config.json');
    });

    it('withholds the MCP config editor until the initial document load settles', async () => {
      const operations = createMockOperations();
      let resolveRead: ((document: McpConfigTextDocument) => void) | undefined;
      operations.readMcpConfigText = vi.fn(
        async () =>
          await new Promise<McpConfigTextDocument>((resolve) => {
            resolveRead = resolve;
          })
      );
      operations.writeMcpConfigText = vi
        .fn()
        .mockResolvedValue({ path: '/tmp/mcp.config.json', success: true });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      await waitFor(() => {
        expect(operations.readMcpConfigText).toHaveBeenCalled();
      });
      // Editing before the read lands loses the edit: the late load overwrites
      // the editor value and clears the save status the user just saw.
      expect(screen.getByTestId('mcp-config-editor-panel')).toBeInTheDocument();
      expect(screen.queryByTestId('mcp-config-editor')).not.toBeInTheDocument();
      expect(screen.queryByTestId('mcp-config-save')).not.toBeInTheDocument();

      await act(async () => {
        resolveRead?.({
          content: '{\n  "servers": []\n}',
          created: false,
          exists: true,
          path: '/tmp/mcp.config.json',
        });
      });

      expect(screen.getByTestId('mcp-config-editor')).toHaveValue('{\n  "servers": []\n}');
    });

    it('recommends Streamable HTTP for new remote MCP servers and labels SSE as legacy', async () => {
      const operations = createMockOperations();
      operations.readMcpConfigText = vi.fn().mockResolvedValue({
        content: '{\n  "servers": []\n}',
        created: false,
        exists: true,
        path: '/tmp/mcp.config.json',
      });
      operations.writeMcpConfigText = vi
        .fn()
        .mockResolvedValue({ path: '/tmp/mcp.config.json', success: true });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      expect(
        await screen.findByText(/use `streamable-http` for new remote endpoints/iu)
      ).toBeInTheDocument();
      expect(screen.getByText(/Streamable HTTP example \(recommended\)/u)).toBeInTheDocument();
      expect(screen.getByText(/Legacy SSE example/u)).toBeInTheDocument();
      expect(
        screen.getByText(/"url": "https:\/\/your-host\.example\.com\/mcp"/u)
      ).toBeInTheDocument();
    });

    it('saves MCP config editor content', async () => {
      const operations = createMockOperations();
      operations.readMcpConfigText = vi.fn().mockResolvedValue({
        content: '{\n  "servers": []\n}',
        created: false,
        exists: true,
        path: '/tmp/mcp.config.json',
      });
      operations.writeMcpConfigText = vi
        .fn()
        .mockResolvedValue({ path: '/tmp/mcp.config.json', success: true });

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
        content: '{\n  "servers": []\n}',
        created: false,
        exists: true,
        path: '/tmp/mcp.config.json',
      });
      operations.writeMcpConfigText = vi
        .fn()
        .mockResolvedValue({ path: '/tmp/mcp.config.json', success: true });
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
        content: '{\n  "servers": []\n}',
        created: false,
        exists: true,
        path: '/tmp/mcp.config.json',
      });
      operations.writeMcpConfigText = vi
        .fn()
        .mockResolvedValue({ path: '/tmp/mcp.config.json', success: true });
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
        content: '{\n  "servers": []\n}',
        created: false,
        exists: true,
        path: '/tmp/mcp.config.json',
      });
      operations.writeMcpConfigText = vi.fn().mockResolvedValue({
        error: 'Invalid JSONC payload',
        path: '/tmp/mcp.config.json',
        success: false,
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
        content: '{\n  "servers": []\n}',
        created: false,
        exists: true,
        path: '/tmp/mcp.config.json',
      });
      operations.writeMcpConfigText = vi
        .fn()
        .mockResolvedValue({ path: '/tmp/mcp.config.json', success: true });
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
        content: '{\n  "servers": []\n}',
        created: true,
        exists: false,
        path: '/tmp/mcp.config.json',
      });
      operations.writeMcpConfigText = vi
        .fn()
        .mockResolvedValue({ path: '/tmp/mcp.config.json', success: true });

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
        .mockResolvedValue({ path: '/tmp/mcp.config.json', success: true });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      await waitFor(() => {
        expect(screen.getByTestId('mcp-config-error')).toHaveTextContent('Config read failed');
      });
    });

    it('rejects relative MCP config paths in the editor', async () => {
      const operations = createMockOperations();
      operations.readMcpConfigText = vi.fn().mockResolvedValue({
        content: '{\n  "servers": []\n}',
        created: false,
        exists: true,
        path: '/tmp/mcp.config.json',
      });
      operations.writeMcpConfigText = vi
        .fn()
        .mockResolvedValue({ path: '/tmp/mcp.config.json', success: true });
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
        content: '{\n  "servers": []\n}',
        created: false,
        exists: true,
        path: '/tmp/mcp.config.json',
      });
      operations.writeMcpConfigText = vi
        .fn()
        .mockResolvedValue({ path: '/tmp/mcp.config.json', success: true });

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
        content: '{\n  "servers": []\n}',
        created: false,
        exists: true,
        path: '/tmp/mcp.config.json',
      });
      operations.writeMcpConfigText = vi
        .fn()
        .mockResolvedValue({ path: '/tmp/mcp.config.json', success: true });

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
        content: '{\n  "servers": []\n}',
        created: false,
        exists: true,
        path: '/tmp/mcp.config.json',
      });
      operations.writeMcpConfigText = vi
        .fn()
        .mockResolvedValue({ path: '/tmp/mcp.config.json', success: true });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      await waitFor(() => {
        expect(screen.getByLabelText('MCP Config Path')).toBeInTheDocument();
        expect(screen.getByLabelText('Config Editor (JSONC)')).toBeInTheDocument();
      });
    });

    it('associates status and error feedback with the editor via aria-describedby', async () => {
      const operations = createMockOperations();
      operations.readMcpConfigText = vi.fn().mockResolvedValue({
        content: '{\n  "servers": []\n}',
        created: true,
        exists: false,
        path: '/tmp/mcp.config.json',
      });
      operations.writeMcpConfigText = vi.fn().mockResolvedValue({
        error: 'Invalid JSONC payload',
        path: '/tmp/mcp.config.json',
        success: false,
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
        content: '{\n  "servers": []\n}',
        created: false,
        exists: true,
        path: '/tmp/mcp.config.json',
      });
      operations.writeMcpConfigText = vi
        .fn()
        .mockResolvedValue({ path: '/tmp/mcp.config.json', success: true });

      render(<UnifiedToolsSettings mcpAvailable={true} operations={operations} />);

      const editor = await screen.findByTestId('mcp-config-editor');
      fireEvent.change(editor, {
        target: { value: '{\n  "servers": [{"transport":"stdio","name":"x","command":"node"}]\n}' },
      });
      fireEvent.keyDown(editor, { ctrlKey: true, key: 's' });

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
        getConditionalToolsBudget: () => 10_000,
        getContextResultsBudget: () => 20_000,
        getCriticalToolsBudget: () => 5000,
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
