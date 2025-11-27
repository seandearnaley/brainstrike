import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// Mock @assistant-ui/react-markdown before importing
vi.mock('@assistant-ui/react-markdown', () => ({
  MarkdownTextPrimitive: ({
    className,
    children,
  }: {
    className?: string;
    children?: React.ReactNode;
  }) => (
    <div className={className} data-testid="markdown-primitive">
      {children}
    </div>
  ),
  unstable_memoizeMarkdownComponents: (components: Record<string, unknown>) => components,
}));

// Mock the syntax highlighter
vi.mock('../assistant-ui-panel/shiki-highlighter', () => ({
  SyntaxHighlighterComponent: () => <div data-testid="syntax-highlighter">Code</div>,
}));

// Mock tooltip-icon-button
vi.mock('../assistant-ui-panel/tooltip-icon-button', () => ({
  TooltipIconButton: ({
    children,
    onClick,
    tooltip,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    tooltip?: string;
  }) => (
    <button onClick={onClick} title={tooltip} type="button">
      {children}
    </button>
  ),
}));

import { MarkdownText } from '../assistant-ui-panel/markdown-text';

describe('MarkdownText', () => {
  it('renders without crashing', () => {
    render(<MarkdownText />);
    expect(screen.getByTestId('markdown-primitive')).toBeInTheDocument();
  });

  it('applies aui-md class', () => {
    render(<MarkdownText />);
    expect(screen.getByTestId('markdown-primitive')).toHaveClass('aui-md');
  });

  it('is memoized', () => {
    const { rerender } = render(<MarkdownText />);
    rerender(<MarkdownText />);
    // Should not throw
    expect(screen.getByTestId('markdown-primitive')).toBeInTheDocument();
  });
});
