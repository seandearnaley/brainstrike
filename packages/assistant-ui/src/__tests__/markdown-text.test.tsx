import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const useMessagePartTextMock = vi.hoisted(() =>
  vi.fn(() => ({
    status: { type: 'complete' },
    text: 'Rendered markdown',
    type: 'text',
  }))
);

vi.mock('@assistant-ui/react', () => ({
  useMessagePartText: useMessagePartTextMock,
}));

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
        code: 'const answer = 42;',
        language: 'typescript',
      })}
    </div>
  ),
  unstable_memoizeMarkdownComponents: (components: Record<string, unknown>) => components,
}));

// Mock the syntax highlighter
vi.mock('../shiki-highlighter', () => ({
  SyntaxHighlighterComponent: () => <div data-testid="syntax-highlighter">Code</div>,
}));

// Preserve the original seam: CodeBlockHeader owns this relative primitive,
// so mock its hoisted location directly instead of replacing the ui barrel.
vi.mock('../../../ui/src/tooltip-icon-button', () => ({
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

import { MarkdownText } from '../markdown-text';

describe('MarkdownText', () => {
  beforeEach(() => {
    useMessagePartTextMock.mockReturnValue({
      status: { type: 'complete' },
      text: 'Rendered markdown',
      type: 'text',
    });
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as Navigator);
  });

  afterEach(() => {
    (window as unknown as { clipboard?: unknown }).clipboard = undefined;
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

  it('renders the shared thinking indicator for an empty running text part', () => {
    useMessagePartTextMock.mockReturnValue({
      status: { type: 'running' },
      text: '',
      type: 'text',
    });

    render(<MarkdownText />);

    expect(screen.queryByTestId('markdown-primitive')).not.toBeInTheDocument();
    expect(screen.getByTestId('assistant-thinking-indicator')).toHaveTextContent('Thinking');
    expect(screen.getByTestId('assistant-thinking-mark')).toHaveAttribute('data-tone', 'greyscale');
  });

  it('keeps the thinking indicator when a running chunk is nothing but a citation marker', () => {
    // Raw text is non-empty, but everything in it is stripped before render.
    // Testing the raw text here would drop the streaming dots and leave the
    // message blank until real prose arrived.
    useMessagePartTextMock.mockReturnValue({
      status: { type: 'running' },
      text: '\u{E200}cite\u{E202}turn0search0\u{E201}',
      type: 'text',
    });

    render(<MarkdownText />);

    expect(screen.queryByTestId('markdown-primitive')).not.toBeInTheDocument();
    expect(screen.getByTestId('assistant-thinking-indicator')).toBeInTheDocument();
  });

  it('keeps empty running reasoning parts in the markdown primitive', () => {
    useMessagePartTextMock.mockReturnValue({
      status: { type: 'running' },
      text: '',
      type: 'reasoning',
    });

    render(<MarkdownText />);

    expect(screen.getByTestId('markdown-primitive')).toBeInTheDocument();
    expect(screen.queryByTestId('assistant-thinking-indicator')).not.toBeInTheDocument();
  });

  it('uses Electron clipboard when available and blocks duplicate copies while copied', async () => {
    // The desktop bridge (BST-1648) resolves on success and REJECTS on failure:
    // the preload has already unwrapped the IPC envelope.
    const electronWriteText = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { clipboard?: { writeText: (text: string) => unknown } }).clipboard = {
      writeText: electronWriteText,
    };

    render(<MarkdownText />);
    const copyButton = screen.getByRole('button', { name: 'Copy code to clipboard' });

    fireEvent.click(copyButton);
    await waitFor(() => {
      expect(copyButton).toHaveAttribute('title', 'Copied!');
    });
    fireEvent.click(copyButton);

    expect(electronWriteText).toHaveBeenCalledTimes(1);
    expect(electronWriteText).toHaveBeenCalledWith('const answer = 42;');
  });

  it('does not fall back to navigator when the Electron bridge write fails', async () => {
    const electronWriteText = vi
      .fn()
      .mockRejectedValue(new Error('write failed (clipboard · write_failed)'));
    (window as unknown as { clipboard?: { writeText: (text: string) => unknown } }).clipboard = {
      writeText: electronWriteText,
    };
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      clipboard: { writeText },
    } as unknown as Navigator);

    render(<MarkdownText />);
    const copyButton = screen.getByRole('button', { name: 'Copy code to clipboard' });
    fireEvent.click(copyButton);

    await waitFor(() => {
      expect(electronWriteText).toHaveBeenCalledWith('const answer = 42;');
    });
    expect(writeText).not.toHaveBeenCalled();
    // The failure must be VISIBLE (not the idle 'Copy code' tooltip): a broken
    // Electron bridge never silently looks like a fresh copy affordance.
    await waitFor(() => {
      expect(copyButton).toHaveAttribute('title', 'Copy failed');
    });
  });

  it('uses web clipboard when Electron clipboard is unavailable', async () => {
    (window as unknown as { clipboard?: { writeText?: (text: string) => unknown } }).clipboard = {};
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
