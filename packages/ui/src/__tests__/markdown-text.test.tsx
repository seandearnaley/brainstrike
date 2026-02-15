import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock @assistant-ui/react-markdown before importing
vi.mock('@assistant-ui/react-markdown', () => ({
  MarkdownTextPrimitive: ({
    className,
    components,
  }: {
    className?: string;
    components?: Record<string, unknown>;
  }) => (
    <div className={className} data-testid="markdown-primitive">
      {(
        components?.['CodeHeader'] as
          | ((props: { language?: string; code?: string }) => React.ReactNode)
          | undefined
      )?.({
        language: 'typescript',
        code: 'const answer = 42;',
      })}
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
    ...props
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    tooltip?: string;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button onClick={onClick} title={tooltip} type="button" {...props}>
      {children}
    </button>
  ),
}));

import { MarkdownText } from '../assistant-ui-panel/markdown-text';

describe('MarkdownText', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as Navigator);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it('uses Electron clipboard when available and blocks duplicate copies while copied', () => {
    const electronWriteText = vi.fn().mockReturnValue(true);
    (window as unknown as { clipboard?: { writeText: (text: string) => boolean } }).clipboard = {
      writeText: electronWriteText,
    };

    render(<MarkdownText />);
    const copyButton = screen.getByRole('button', { name: 'Copy code to clipboard' });

    fireEvent.click(copyButton);
    fireEvent.click(copyButton);

    expect(electronWriteText).toHaveBeenCalledTimes(1);
    expect(electronWriteText).toHaveBeenCalledWith('const answer = 42;');
    expect(copyButton).toHaveAttribute('title', 'Copied!');
  });

  it('falls back to web clipboard when Electron clipboard is unavailable', async () => {
    (window as unknown as { clipboard?: { writeText?: (text: string) => boolean } }).clipboard = {};
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      clipboard: { writeText },
    } as unknown as Navigator);

    render(<MarkdownText />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy code to clipboard' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('const answer = 42;');
    });
  });
});
