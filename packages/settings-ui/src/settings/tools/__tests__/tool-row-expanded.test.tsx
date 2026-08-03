/**
 * Tool Row Expanded Tests
 *
 * Tests for the expanded details view that appears when a tool row is clicked.
 */

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRowExpanded } from '../tool-row-expanded';
import type { ToolDisplayMetadata, ToolExecutionResult } from '../types';

// Mock @brainstrike/ui
vi.mock('@brainstrike/ui', () => ({
  Badge: ({
    children,
    variant,
    className,
  }: {
    children: React.ReactNode;
    variant?: string;
    className?: string;
  }) => (
    <span className={className} data-testid="badge" data-variant={variant}>
      {children}
    </span>
  ),
  cn: (...args: (string | boolean | undefined)[]) => args.filter(Boolean).join(' '),
}));

// Mock ToolPlayground
vi.mock('../tool-playground', () => ({
  ToolPlayground: ({
    toolId,
    inputSchema,
    onExecute,
  }: {
    toolId: string;
    inputSchema?: unknown;
    onExecute: (input: unknown) => Promise<ToolExecutionResult>;
  }) => (
    <div
      data-has-execute={typeof onExecute === 'function'}
      data-input-schema={JSON.stringify(inputSchema)}
      data-testid={`tool-playground-${toolId}`}
    >
      Mock Playground for {toolId}
    </div>
  ),
}));

describe('ToolRowExpanded', () => {
  const nativeTool: ToolDisplayMetadata = {
    category: 'retrieval',
    description: 'Retrieve context from the knowledge base for AI-assisted queries',
    enabled: true,
    estimatedTokens: 150,
    id: 'brainstrike.retrieveContext',
    loadingTier: 'critical',
    requiresApproval: false,
    source: 'native',
  };

  const mcpTool: ToolDisplayMetadata = {
    category: 'action',
    description: 'Read files from the filesystem using MCP server',
    enabled: true,
    estimatedTokens: 200,
    id: 'mcp.filesystem.read',
    inputSchema: { properties: { path: { type: 'string' } }, type: 'object' },
    loadingTier: 'conditional',
    requiresApproval: true,
    serverName: 'filesystem-server',
    source: 'mcp',
  };

  const mockExecuteTest = vi.fn().mockResolvedValue({
    durationMs: 100,
    result: { data: 'test' },
    success: true,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('description', () => {
    it('renders full description without truncation', () => {
      render(<ToolRowExpanded tool={nativeTool} />);

      const description = screen.getByText(
        'Retrieve context from the knowledge base for AI-assisted queries'
      );
      expect(description).toBeInTheDocument();
      expect(description.tagName).toBe('P');
      expect(description).toHaveClass('text-sm');
      // Verify no truncation class
      expect(description).not.toHaveClass('truncate');
      expect(description).not.toHaveClass('line-clamp');
    });

    it('renders MCP tool description', () => {
      render(<ToolRowExpanded tool={mcpTool} />);

      expect(
        screen.getByText('Read files from the filesystem using MCP server')
      ).toBeInTheDocument();
    });
  });

  describe('MCP server name', () => {
    it('renders server name for MCP tools', () => {
      render(<ToolRowExpanded tool={mcpTool} />);

      expect(screen.getByText('Server:')).toBeInTheDocument();
      expect(screen.getByText('filesystem-server')).toBeInTheDocument();
    });

    it('does not render server name for native tools', () => {
      render(<ToolRowExpanded tool={nativeTool} />);

      expect(screen.queryByText('Server:')).not.toBeInTheDocument();
    });

    it('does not render server name for MCP tools without serverName', () => {
      const { serverName: _, ...mcpToolWithoutServer } = mcpTool;
      const mcpToolNoServer: ToolDisplayMetadata = mcpToolWithoutServer;
      render(<ToolRowExpanded tool={mcpToolNoServer} />);

      expect(screen.queryByText('Server:')).not.toBeInTheDocument();
    });
  });

  describe('approval badge', () => {
    it('renders "Requires Approval" badge when required', () => {
      render(<ToolRowExpanded tool={mcpTool} />);

      const badge = screen.getByTestId('badge');
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveTextContent('Requires Approval');
      expect(badge).toHaveAttribute('data-variant', 'outline');
    });

    it('does not render approval badge when not required', () => {
      render(<ToolRowExpanded tool={nativeTool} />);

      expect(screen.queryByTestId('badge')).not.toBeInTheDocument();
    });
  });

  describe('playground', () => {
    it('renders playground when onExecuteTest is provided', () => {
      render(<ToolRowExpanded onExecuteTest={mockExecuteTest} tool={nativeTool} />);

      expect(screen.getByTestId(`tool-playground-${nativeTool.id}`)).toBeInTheDocument();
    });

    it('does not render playground when onExecuteTest is not provided', () => {
      render(<ToolRowExpanded tool={nativeTool} />);

      expect(screen.queryByTestId(`tool-playground-${nativeTool.id}`)).not.toBeInTheDocument();
    });

    it('passes correct props to playground', () => {
      render(<ToolRowExpanded onExecuteTest={mockExecuteTest} tool={mcpTool} />);

      const playground = screen.getByTestId(`tool-playground-${mcpTool.id}`);
      expect(playground).toHaveAttribute('data-has-execute', 'true');
      expect(playground).toHaveAttribute('data-input-schema', JSON.stringify(mcpTool.inputSchema));
    });
  });

  describe('test id', () => {
    it('has correct test id for native tool', () => {
      render(<ToolRowExpanded tool={nativeTool} />);

      expect(screen.getByTestId(`tool-row-expanded-${nativeTool.id}`)).toBeInTheDocument();
    });

    it('has correct test id for MCP tool', () => {
      render(<ToolRowExpanded tool={mcpTool} />);

      expect(screen.getByTestId(`tool-row-expanded-${mcpTool.id}`)).toBeInTheDocument();
    });
  });

  describe('styling', () => {
    it('has animation classes for slide-in effect', () => {
      render(<ToolRowExpanded tool={nativeTool} />);

      const expanded = screen.getByTestId(`tool-row-expanded-${nativeTool.id}`);
      expect(expanded.className).toContain('animate-in');
      expect(expanded.className).toContain('slide-in-from-top-1');
      expect(expanded.className).toContain('fade-in');
      expect(expanded.className).toContain('duration-200');
    });

    it('has correct container styling', () => {
      render(<ToolRowExpanded tool={nativeTool} />);

      const expanded = screen.getByTestId(`tool-row-expanded-${nativeTool.id}`);
      expect(expanded.className).toContain('ml-6');
      expect(expanded.className).toContain('mt-1');
      expect(expanded.className).toContain('rounded-md');
      expect(expanded.className).toContain('border');
      expect(expanded.className).toContain('border-border/50');
      expect(expanded.className).toContain('bg-muted/20');
      expect(expanded.className).toContain('p-3');
    });
  });

  describe('metadata section', () => {
    it('renders metadata section with correct styling', () => {
      render(<ToolRowExpanded tool={mcpTool} />);

      // Both server name and badge should be in the metadata section
      const serverLabel = screen.getByText('Server:');
      const badge = screen.getByTestId('badge');

      // Find the common ancestor metadata container (the flex container)
      const expanded = screen.getByTestId(`tool-row-expanded-${mcpTool.id}`);

      // Both elements should be within the expanded container
      expect(expanded).toContainElement(serverLabel);
      expect(expanded).toContainElement(badge);
    });

    it('renders empty metadata section gracefully for native tools without approval', () => {
      render(<ToolRowExpanded tool={nativeTool} />);

      // Should not throw, and should still render the container
      const expanded = screen.getByTestId(`tool-row-expanded-${nativeTool.id}`);
      expect(expanded).toBeInTheDocument();
    });
  });
});
