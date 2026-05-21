/**
 * Tool Row Tests
 *
 * Tests for the dense, table-like row component for displaying individual tools.
 */

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRow } from '../tool-row';
import type { ToolDisplayMetadata } from '../types';

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
  Switch: ({
    checked,
    onCheckedChange,
    onClick,
    'data-testid': testId,
    className,
  }: {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    onClick?: (e: React.MouseEvent) => void;
    'data-testid'?: string;
    className?: string;
  }) => (
    <button
      aria-checked={checked}
      className={className}
      data-testid={testId ?? 'switch'}
      onClick={(e) => {
        onClick?.(e);
        onCheckedChange?.(!checked);
      }}
      role="switch"
      type="button"
    />
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) => (
    <div data-as-child={asChild} data-testid="tooltip-trigger">
      {children}
    </div>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
  cn: (...args: (string | boolean | undefined)[]) => args.filter(Boolean).join(' '),
}));

// Mock @brainstrike/assistant-contract/local-runtime
vi.mock('@brainstrike/assistant-contract/local-runtime', () => ({
  TOOL_CATEGORIES: {
    retrieval: {
      id: 'retrieval',
      label: 'Retrieval',
      description: 'Search tools',
      loadPriority: 1,
    },
    action: { id: 'action', label: 'Actions', description: 'Action tools', loadPriority: 3 },
    analysis: { id: 'analysis', label: 'Analysis', description: 'Analysis tools', loadPriority: 2 },
    configuration: {
      id: 'configuration',
      label: 'Configuration',
      description: 'Config tools',
      loadPriority: 4,
    },
    validation: {
      id: 'validation',
      label: 'Validation',
      description: 'Validation tools',
      loadPriority: 5,
    },
  },
  TOOL_LOADING_TIERS: {
    critical: { id: 'critical', label: 'Critical', description: 'Always loaded' },
    conditional: { id: 'conditional', label: 'Conditional', description: 'Budget-based loading' },
    deferred: { id: 'deferred', label: 'Deferred', description: 'On-demand loading' },
  },
}));

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  AlertTriangle: ({ className }: { className?: string }) => (
    <span className={className} data-testid="warning-icon" />
  ),
  ChevronDown: ({ className }: { className?: string }) => <span className={className} />,
  ChevronRight: ({ className }: { className?: string }) => <span className={className} />,
}));

describe('ToolRow', () => {
  const defaultTool: ToolDisplayMetadata = {
    id: 'brainstrike.retrieveContext',
    source: 'native',
    category: 'retrieval',
    loadingTier: 'critical',
    description: 'Retrieve context from the knowledge base for AI-assisted queries',
    enabled: true,
    estimatedTokens: 150,
    requiresApproval: false,
  };

  const defaultProps = {
    tool: defaultTool,
    onToggle: vi.fn().mockResolvedValue(undefined),
    onExpand: vi.fn(),
    expanded: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('renders tool name in monospace', () => {
      render(<ToolRow {...defaultProps} />);

      const codeElement = screen.getByRole('row').querySelector('code');
      expect(codeElement).toBeInTheDocument();
      expect(codeElement).toHaveClass('font-mono');
      expect(codeElement).toHaveTextContent('brainstrike.retrieveContext');
    });

    it('renders abbreviated tier label for conditional', () => {
      const props = {
        ...defaultProps,
        tool: { ...defaultTool, loadingTier: 'conditional' as const },
      };
      render(<ToolRow {...props} />);

      expect(screen.getByText('Cond.')).toBeInTheDocument();
    });

    it('renders abbreviated tier label for deferred', () => {
      const props = {
        ...defaultProps,
        tool: { ...defaultTool, loadingTier: 'deferred' as const },
      };
      render(<ToolRow {...props} />);

      expect(screen.getByText('Defer.')).toBeInTheDocument();
    });

    it('renders full label for Critical tier', () => {
      render(<ToolRow {...defaultProps} />);

      expect(screen.getByText('Critical')).toBeInTheDocument();
    });

    it('renders category label', () => {
      render(<ToolRow {...defaultProps} />);

      expect(screen.getByText('Retrieval')).toBeInTheDocument();
    });

    it('renders token count in ~X format', () => {
      render(<ToolRow {...defaultProps} />);

      expect(screen.getByText('~150')).toBeInTheDocument();
    });
  });

  describe('approval warning', () => {
    it('shows warning icon for tools requiring approval', () => {
      const props = {
        ...defaultProps,
        tool: { ...defaultTool, requiresApproval: true },
      };
      render(<ToolRow {...props} />);

      expect(screen.getByTestId('warning-icon')).toBeInTheDocument();
    });

    it('does not show warning icon for tools not requiring approval', () => {
      render(<ToolRow {...defaultProps} />);

      expect(screen.queryByTestId('warning-icon')).not.toBeInTheDocument();
    });
  });

  describe('toggle interaction', () => {
    it('calls onToggle when switch is clicked', async () => {
      render(<ToolRow {...defaultProps} />);

      const switchButton = screen.getByRole('switch');
      fireEvent.click(switchButton);

      expect(defaultProps.onToggle).toHaveBeenCalledTimes(1);
      expect(defaultProps.onToggle).toHaveBeenCalledWith(
        'brainstrike.retrieveContext',
        true // currentlyEnabled
      );
    });

    it('passes currentlyEnabled=false when tool is disabled', async () => {
      const props = {
        ...defaultProps,
        tool: { ...defaultTool, enabled: false },
      };
      render(<ToolRow {...props} />);

      const switchButton = screen.getByRole('switch');
      fireEvent.click(switchButton);

      expect(defaultProps.onToggle).toHaveBeenCalledWith(
        'brainstrike.retrieveContext',
        false // currentlyEnabled
      );
    });
  });

  describe('expand interaction', () => {
    it('calls onExpand when row is clicked', () => {
      render(<ToolRow {...defaultProps} />);

      const row = screen.getByRole('row');
      fireEvent.click(row);

      expect(defaultProps.onExpand).toHaveBeenCalledTimes(1);
      expect(defaultProps.onExpand).toHaveBeenCalledWith('brainstrike.retrieveContext');
    });

    it('does not call onExpand when toggle is clicked (event isolation)', () => {
      render(<ToolRow {...defaultProps} />);

      const switchButton = screen.getByRole('switch');
      fireEvent.click(switchButton);

      expect(defaultProps.onExpand).not.toHaveBeenCalled();
    });

    it('supports keyboard navigation with Enter', () => {
      render(<ToolRow {...defaultProps} />);

      const row = screen.getByRole('row');
      fireEvent.keyDown(row, { key: 'Enter' });

      expect(defaultProps.onExpand).toHaveBeenCalledTimes(1);
      expect(defaultProps.onExpand).toHaveBeenCalledWith('brainstrike.retrieveContext');
    });

    it('supports keyboard navigation with Space', () => {
      render(<ToolRow {...defaultProps} />);

      const row = screen.getByRole('row');
      fireEvent.keyDown(row, { key: ' ' });

      expect(defaultProps.onExpand).toHaveBeenCalledTimes(1);
      expect(defaultProps.onExpand).toHaveBeenCalledWith('brainstrike.retrieveContext');
    });
  });

  describe('visual states', () => {
    it('applies muted opacity when disabled', () => {
      const props = {
        ...defaultProps,
        tool: { ...defaultTool, enabled: false },
      };
      render(<ToolRow {...props} />);

      const row = screen.getByRole('row');
      expect(row).toHaveClass('opacity-70');
    });

    it('does not apply muted opacity when enabled', () => {
      render(<ToolRow {...defaultProps} />);

      const row = screen.getByRole('row');
      expect(row).not.toHaveClass('opacity-70');
    });

    it('shows ChevronDown when expanded', () => {
      const props = {
        ...defaultProps,
        expanded: true,
      };
      render(<ToolRow {...props} />);

      expect(screen.getByTestId('chevron-down')).toBeInTheDocument();
      expect(screen.queryByTestId('chevron-right')).not.toBeInTheDocument();
    });

    it('shows ChevronRight when collapsed', () => {
      render(<ToolRow {...defaultProps} />);

      expect(screen.getByTestId('chevron-right')).toBeInTheDocument();
      expect(screen.queryByTestId('chevron-down')).not.toBeInTheDocument();
    });
  });

  describe('approval tooltip', () => {
    it('shows approval tooltip for tools requiring approval', () => {
      const props = {
        ...defaultProps,
        tool: { ...defaultTool, requiresApproval: true },
      };
      render(<ToolRow {...props} />);

      const tooltipContent = screen.getByTestId('tooltip-content');
      expect(tooltipContent).toHaveTextContent('Requires user approval before execution');
    });

    it('does not render tooltip when tool does not require approval', () => {
      render(<ToolRow {...defaultProps} />);

      expect(screen.queryByTestId('tooltip-content')).not.toBeInTheDocument();
    });
  });

  describe('accessibility', () => {
    it('has correct tabIndex for keyboard navigation', () => {
      render(<ToolRow {...defaultProps} />);

      const row = screen.getByRole('row');
      expect(row).toHaveAttribute('tabIndex', '0');
    });

    it('switch reflects enabled state via aria-checked', () => {
      render(<ToolRow {...defaultProps} />);

      const switchButton = screen.getByRole('switch');
      expect(switchButton).toHaveAttribute('aria-checked', 'true');
    });

    it('switch reflects disabled state via aria-checked', () => {
      const props = {
        ...defaultProps,
        tool: { ...defaultTool, enabled: false },
      };
      render(<ToolRow {...props} />);

      const switchButton = screen.getByRole('switch');
      expect(switchButton).toHaveAttribute('aria-checked', 'false');
    });
  });

  describe('optional callbacks', () => {
    it('handles missing onExpand gracefully', () => {
      const props = {
        tool: defaultTool,
        onToggle: vi.fn().mockResolvedValue(undefined),
        // onExpand is not provided
      };

      // Should not throw
      render(<ToolRow {...props} />);

      const row = screen.getByRole('row');
      // Should not throw when clicking
      fireEvent.click(row);
    });
  });
});
