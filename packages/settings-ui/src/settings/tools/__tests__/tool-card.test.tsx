/**
 * Tool Card Tests
 */

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolCard } from '../tool-card';
import type { ToolDisplayMetadata, ToolExecutionResult } from '../types';

// Mock @brainstrike/assistant-contract/tool-metadata
vi.mock('@brainstrike/assistant-contract/tool-metadata', () => ({
  TOOL_CATEGORIES: {
    action: { label: 'Actions' },
    analysis: { label: 'Analysis' },
    configuration: { label: 'Configuration' },
    retrieval: { label: 'Retrieval' },
    validation: { label: 'Validation' },
  },
  TOOL_LOADING_TIERS: {
    conditional: { label: 'Conditional' },
    critical: { label: 'Critical' },
    deferred: { label: 'Deferred' },
  },
}));

// Mock @brainstrike/ui
vi.mock('@brainstrike/ui', () => ({
  Badge: ({ children, variant }: { children: React.ReactNode; variant?: string }) => (
    <span data-testid="badge" data-variant={variant}>
      {children}
    </span>
  ),
  Switch: ({
    checked,
    onCheckedChange,
    'data-testid': testId,
  }: {
    checked: boolean;
    onCheckedChange: () => void;
    'data-testid'?: string;
  }) => (
    <button
      aria-checked={checked}
      data-testid={testId}
      onClick={onCheckedChange}
      role="switch"
      type="button"
    >
      {checked ? 'On' : 'Off'}
    </button>
  ),
}));

// Mock ToolPlayground
vi.mock('../tool-playground', () => ({
  ToolPlayground: ({ toolId }: { toolId: string }) => (
    <div data-testid={`playground-${toolId}`}>Tool Playground</div>
  ),
}));

describe('ToolCard', () => {
  const mockTool: ToolDisplayMetadata = {
    category: 'retrieval',
    description: 'Search across documents using hybrid semantic and keyword search',
    enabled: true,
    estimatedTokens: 150,
    id: 'brainstrike.hybridSearch',
    loadingTier: 'critical',
    requiresApproval: false,
    source: 'native',
  };

  const mockOnToggle = vi.fn();
  const mockOnExpandChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('renders the tool card with correct data', () => {
      render(<ToolCard onToggle={mockOnToggle} tool={mockTool} />);

      expect(screen.getByTestId('tool-card-brainstrike.hybridSearch')).toBeInTheDocument();
      expect(screen.getByText('brainstrike.hybridSearch')).toBeInTheDocument();
      expect(screen.getByText('Critical')).toBeInTheDocument();
      expect(screen.getByText('Retrieval')).toBeInTheDocument();
      expect(screen.getByText(/~150 tokens/)).toBeInTheDocument();
    });

    it('renders the tool description', () => {
      render(<ToolCard onToggle={mockOnToggle} tool={mockTool} />);

      expect(
        screen.getByText('Search across documents using hybrid semantic and keyword search')
      ).toBeInTheDocument();
    });

    it('renders the toggle switch with correct state', () => {
      render(<ToolCard onToggle={mockOnToggle} tool={mockTool} />);

      const toggle = screen.getByTestId('toggle-brainstrike.hybridSearch');
      expect(toggle).toHaveAttribute('aria-checked', 'true');
    });

    it('shows "Requires Approval" badge when tool requires approval', () => {
      const toolWithApproval = { ...mockTool, requiresApproval: true };
      render(<ToolCard onToggle={mockOnToggle} tool={toolWithApproval} />);

      expect(screen.getByText('Requires Approval')).toBeInTheDocument();
    });

    it('does not show "Requires Approval" badge when not required', () => {
      render(<ToolCard onToggle={mockOnToggle} tool={mockTool} />);

      expect(screen.queryByText('Requires Approval')).not.toBeInTheDocument();
    });
  });

  describe('toggle functionality', () => {
    it('calls onToggle when switch is clicked', () => {
      render(<ToolCard onToggle={mockOnToggle} tool={mockTool} />);

      const toggle = screen.getByTestId('toggle-brainstrike.hybridSearch');
      fireEvent.click(toggle);

      expect(mockOnToggle).toHaveBeenCalledWith('brainstrike.hybridSearch', true);
    });

    it('passes correct enabled state when toggling disabled tool', () => {
      const disabledTool = { ...mockTool, enabled: false };
      render(<ToolCard onToggle={mockOnToggle} tool={disabledTool} />);

      const toggle = screen.getByTestId('toggle-brainstrike.hybridSearch');
      fireEvent.click(toggle);

      expect(mockOnToggle).toHaveBeenCalledWith('brainstrike.hybridSearch', false);
    });
  });

  describe('expand/collapse', () => {
    it('shows collapsed state by default', () => {
      render(<ToolCard onToggle={mockOnToggle} tool={mockTool} />);

      // Should not show expanded content (playground)
      expect(screen.queryByTestId('playground-brainstrike.hybridSearch')).not.toBeInTheDocument();
    });

    it('shows expanded content when expanded prop is true', () => {
      const mockOnExecuteTest = vi.fn();
      render(
        <ToolCard
          expanded={true}
          onExecuteTest={mockOnExecuteTest}
          onToggle={mockOnToggle}
          tool={mockTool}
        />
      );

      expect(screen.getByTestId('playground-brainstrike.hybridSearch')).toBeInTheDocument();
    });

    it('calls onExpandChange when header is clicked', () => {
      render(
        <ToolCard
          expanded={false}
          onExpandChange={mockOnExpandChange}
          onToggle={mockOnToggle}
          tool={mockTool}
        />
      );

      // Click the expand button (the header button)
      const buttons = screen.getAllByRole('button');
      // First button is the expand button (contains tool info)
      const expandButton = buttons[0];
      if (expandButton) {
        fireEvent.click(expandButton);
      }

      expect(mockOnExpandChange).toHaveBeenCalledWith(true);
    });

    it('calls onExpandChange with false when collapsing', () => {
      render(
        <ToolCard
          expanded={true}
          onExpandChange={mockOnExpandChange}
          onToggle={mockOnToggle}
          tool={mockTool}
        />
      );

      const buttons = screen.getAllByRole('button');
      const collapseButton = buttons[0];
      if (collapseButton) {
        fireEvent.click(collapseButton);
      }

      expect(mockOnExpandChange).toHaveBeenCalledWith(false);
    });
  });

  describe('loading tier badges', () => {
    it('renders critical tier badge correctly', () => {
      const criticalTool = { ...mockTool, loadingTier: 'critical' as const };
      render(<ToolCard onToggle={mockOnToggle} tool={criticalTool} />);

      expect(screen.getByText('Critical')).toBeInTheDocument();
    });

    it('renders conditional tier badge correctly', () => {
      const conditionalTool = { ...mockTool, loadingTier: 'conditional' as const };
      render(<ToolCard onToggle={mockOnToggle} tool={conditionalTool} />);

      expect(screen.getByText('Conditional')).toBeInTheDocument();
    });

    it('renders deferred tier badge correctly', () => {
      const deferredTool = { ...mockTool, loadingTier: 'deferred' as const };
      render(<ToolCard onToggle={mockOnToggle} tool={deferredTool} />);

      expect(screen.getByText('Deferred')).toBeInTheDocument();
    });
  });

  describe('category badges', () => {
    it('renders retrieval category correctly', () => {
      render(<ToolCard onToggle={mockOnToggle} tool={mockTool} />);
      expect(screen.getByText('Retrieval')).toBeInTheDocument();
    });

    it('renders action category correctly', () => {
      const actionTool = { ...mockTool, category: 'action' as const };
      render(<ToolCard onToggle={mockOnToggle} tool={actionTool} />);
      expect(screen.getByText('Actions')).toBeInTheDocument();
    });

    it('renders analysis category correctly', () => {
      const analysisTool = { ...mockTool, category: 'analysis' as const };
      render(<ToolCard onToggle={mockOnToggle} tool={analysisTool} />);
      expect(screen.getByText('Analysis')).toBeInTheDocument();
    });
  });

  describe('MCP tools', () => {
    it('renders MCP tool with server name', () => {
      const mcpTool: ToolDisplayMetadata = {
        ...mockTool,
        id: 'mcp__github__search_code',
        serverName: 'github',
        source: 'mcp',
      };
      render(<ToolCard onToggle={mockOnToggle} tool={mcpTool} />);

      expect(screen.getByText('mcp__github__search_code')).toBeInTheDocument();
    });
  });

  describe('playground integration', () => {
    it('does not render playground when onExecuteTest is not provided', () => {
      render(<ToolCard expanded={true} onToggle={mockOnToggle} tool={mockTool} />);

      expect(screen.queryByTestId('playground-brainstrike.hybridSearch')).not.toBeInTheDocument();
    });

    it('renders playground when onExecuteTest is provided and expanded', () => {
      const mockOnExecuteTest =
        vi.fn<(toolId: string, input: unknown) => Promise<ToolExecutionResult>>();
      render(
        <ToolCard
          expanded={true}
          onExecuteTest={mockOnExecuteTest}
          onToggle={mockOnToggle}
          tool={mockTool}
        />
      );

      expect(screen.getByTestId('playground-brainstrike.hybridSearch')).toBeInTheDocument();
    });
  });
});
