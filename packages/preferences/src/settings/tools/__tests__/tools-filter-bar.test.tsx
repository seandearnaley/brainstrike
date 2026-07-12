/**
 * Tools Filter Bar Tests
 */

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolsFilterBar } from '../tools-filter-bar';

// Mock @brainstrike/assistant-contract/tool-metadata
vi.mock('@brainstrike/assistant-contract/tool-metadata', () => ({
  TOOL_CATEGORIES: {
    action: { id: 'action', label: 'Actions' },
    analysis: { id: 'analysis', label: 'Analysis' },
    configuration: { id: 'configuration', label: 'Configuration' },
    retrieval: { id: 'retrieval', label: 'Retrieval' },
    validation: { id: 'validation', label: 'Validation' },
  },
  TOOL_LOADING_TIERS: {
    conditional: { id: 'conditional', label: 'Conditional' },
    critical: { id: 'critical', label: 'Critical' },
    deferred: { id: 'deferred', label: 'Deferred' },
  },
}));

// Mock lucide-react
vi.mock('lucide-react', () => ({
  RotateCcw: () => <svg data-testid="rotate-icon" />,
  Search: (props: React.SVGProps<SVGSVGElement>) => <svg data-testid="search-icon" {...props} />,
}));

// Mock @brainstrike/ui
vi.mock('@brainstrike/ui', () => ({
  Button: ({
    children,
    onClick,
    'data-testid': testId,
    disabled,
  }: {
    children: React.ReactNode;
    onClick: () => void;
    'data-testid'?: string;
    disabled?: boolean;
  }) => (
    <button data-testid={testId} disabled={disabled} onClick={onClick} type="button">
      {children}
    </button>
  ),
  Input: ({
    value,
    onChange,
    placeholder,
    'data-testid': testId,
    className,
    style,
  }: {
    value: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    placeholder?: string;
    'data-testid'?: string;
    className?: string;
    style?: React.CSSProperties;
  }) => (
    <input
      className={className}
      data-testid={testId}
      onChange={onChange}
      placeholder={placeholder}
      style={style}
      type="text"
      value={value}
    />
  ),
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode;
    value: string;
    onValueChange: (value: string) => void;
  }) => (
    <button data-value={value} onClick={() => onValueChange('retrieval')} type="button">
      {children}
    </button>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div data-value={value}>{children}</div>
  ),
  SelectTrigger: ({
    children,
    'data-testid': testId,
  }: {
    children: React.ReactNode;
    'data-testid'?: string;
  }) => <div data-testid={testId}>{children}</div>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
  TooltipTrigger: ({
    children,
    asChild: _asChild,
  }: {
    children: React.ReactNode;
    asChild?: boolean;
  }) => <>{children}</>,
}));

describe('ToolsFilterBar', () => {
  const mockOnSearchChange = vi.fn();
  const mockOnCategoryChange = vi.fn();
  const mockOnTierChange = vi.fn();
  const mockOnReset = vi.fn();

  const defaultProps = {
    categoryFilter: 'all' as const,
    onCategoryChange: mockOnCategoryChange,
    onReset: mockOnReset,
    onSearchChange: mockOnSearchChange,
    onTierChange: mockOnTierChange,
    searchQuery: '',
    tierFilter: 'all' as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('renders the filter bar with all controls', () => {
      render(<ToolsFilterBar {...defaultProps} />);

      expect(screen.getByTestId('tools-filter-bar')).toBeInTheDocument();
      expect(screen.getByTestId('search-input')).toBeInTheDocument();
      expect(screen.getByTestId('category-filter')).toBeInTheDocument();
      expect(screen.getByTestId('tier-filter')).toBeInTheDocument();
      expect(screen.getByTestId('reset-filters')).toBeInTheDocument();
    });

    it('renders search input with correct value', () => {
      render(<ToolsFilterBar {...defaultProps} searchQuery="test query" />);

      const input = screen.getByTestId('search-input') as HTMLInputElement;
      expect(input.value).toBe('test query');
    });

    it('renders search icon inside input container', () => {
      render(<ToolsFilterBar {...defaultProps} />);

      expect(screen.getByTestId('search-icon')).toBeInTheDocument();
    });

    it('displays tool count when provided', () => {
      render(<ToolsFilterBar {...defaultProps} totalCount={42} />);

      expect(screen.getByTestId('tool-count')).toBeInTheDocument();
      expect(screen.getByText('42 tools')).toBeInTheDocument();
    });

    it('does not display tool count when not provided', () => {
      render(<ToolsFilterBar {...defaultProps} />);

      expect(screen.queryByTestId('tool-count')).not.toBeInTheDocument();
    });

    it('shows reset button as icon only (has SVG child)', () => {
      render(<ToolsFilterBar {...defaultProps} />);

      const resetButton = screen.getByTestId('reset-filters');
      expect(resetButton.querySelector('svg')).toBeInTheDocument();
      // aria-label provides the accessible name; no visible text needed
      expect(resetButton.textContent).toBe('');
    });
  });

  describe('search functionality', () => {
    it('calls onSearchChange when typing in search input', () => {
      render(<ToolsFilterBar {...defaultProps} />);

      const input = screen.getByTestId('search-input');
      fireEvent.change(input, { target: { value: 'hybrid' } });

      expect(mockOnSearchChange).toHaveBeenCalledWith('hybrid');
    });

    it('shows placeholder text', () => {
      render(<ToolsFilterBar {...defaultProps} />);

      const input = screen.getByTestId('search-input');
      expect(input).toHaveAttribute('placeholder', 'Search tools...');
      expect(input).toHaveClass('pl-10');
      expect(input).toHaveStyle({ paddingLeft: '2.5rem' });
      expect(input.parentElement?.querySelector('[data-slot="settings-search-icon"]')).toHaveStyle({
        left: '0.75rem',
      });
    });
  });

  describe('category filter', () => {
    it('renders category options', () => {
      render(<ToolsFilterBar {...defaultProps} />);

      expect(screen.getByText('All Categories')).toBeInTheDocument();
      expect(screen.getByText('Retrieval')).toBeInTheDocument();
      expect(screen.getByText('Actions')).toBeInTheDocument();
      expect(screen.getByText('Analysis')).toBeInTheDocument();
    });
  });

  describe('tier filter', () => {
    it('renders tier options', () => {
      render(<ToolsFilterBar {...defaultProps} />);

      expect(screen.getByText('All Tiers')).toBeInTheDocument();
      expect(screen.getByText('Critical')).toBeInTheDocument();
      expect(screen.getByText('Conditional')).toBeInTheDocument();
      expect(screen.getByText('Deferred')).toBeInTheDocument();
    });
  });

  describe('reset functionality', () => {
    it('calls onReset when reset button is clicked', () => {
      render(<ToolsFilterBar {...defaultProps} searchQuery="test" />);

      const resetButton = screen.getByTestId('reset-filters');
      fireEvent.click(resetButton);

      expect(mockOnReset).toHaveBeenCalledTimes(1);
    });

    it('disables reset button when no filters active', () => {
      render(<ToolsFilterBar {...defaultProps} />);

      const resetButton = screen.getByTestId('reset-filters');
      expect(resetButton).toBeDisabled();
    });

    it('enables reset button when search query is present', () => {
      render(<ToolsFilterBar {...defaultProps} searchQuery="test" />);

      const resetButton = screen.getByTestId('reset-filters');
      expect(resetButton).not.toBeDisabled();
    });

    it('enables reset button when category filter is not all', () => {
      render(<ToolsFilterBar {...defaultProps} categoryFilter="retrieval" />);

      const resetButton = screen.getByTestId('reset-filters');
      expect(resetButton).not.toBeDisabled();
    });

    it('enables reset button when tier filter is not all', () => {
      render(<ToolsFilterBar {...defaultProps} tierFilter="critical" />);

      const resetButton = screen.getByTestId('reset-filters');
      expect(resetButton).not.toBeDisabled();
    });
  });

  describe('filter values', () => {
    it('passes current search value to input', () => {
      render(<ToolsFilterBar {...defaultProps} searchQuery="current search" />);

      const input = screen.getByTestId('search-input') as HTMLInputElement;
      expect(input.value).toBe('current search');
    });

    it('renders with specific category filter', () => {
      render(<ToolsFilterBar {...defaultProps} categoryFilter="retrieval" />);

      expect(screen.getByTestId('category-filter')).toBeInTheDocument();
    });

    it('renders with specific tier filter', () => {
      render(<ToolsFilterBar {...defaultProps} tierFilter="critical" />);

      expect(screen.getByTestId('tier-filter')).toBeInTheDocument();
    });
  });

  describe('tooltip', () => {
    it('renders tooltip content for reset button', () => {
      render(<ToolsFilterBar {...defaultProps} />);

      expect(screen.getByTestId('tooltip-content')).toBeInTheDocument();
      // Only the tooltip content text; aria-label provides the accessible name
      expect(screen.getByText('Reset filters')).toBeInTheDocument();
    });
  });
});
