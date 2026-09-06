import { TooltipProvider } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { ToolFallback } from '../tool-fallback';
import { extractPrimaryArg } from '../tool-summaries';

beforeAll(() => {
  global.ResizeObserver = class {
    disconnect() {}
    observe() {}
    unobserve() {}
  } as never;
  window.HTMLElement.prototype.scrollIntoView = () => {};
});

function wrap(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('extractPrimaryArg display truncation (BST-949)', () => {
  it('passes short values through with whitespace collapsed', () => {
    expect(extractPrimaryArg({ query: '  hybrid\n search ' }, undefined)).toEqual({
      display: 'hybrid search',
      full: 'hybrid search',
    });
  });

  it('caps prose-like values at 64 visible characters, keeping the full value for the tooltip', () => {
    const longQuery = `find every reference to the composer control dock ${'x'.repeat(80)}`;
    const summary = extractPrimaryArg({ query: longQuery }, undefined);
    expect(summary?.display).toHaveLength(64);
    expect(summary?.display.endsWith('…')).toBe(true);
    expect(summary?.display.startsWith('find every reference')).toBe(true);
    // The untruncated (normalized) value must survive for hover inspection —
    // Compact detail mode has no expander, so the tooltip is the only way in.
    expect(summary?.full).toBe(longQuery);
  });

  it('middle-ellipsizes long paths so the basename stays readable', () => {
    const longPath =
      'packages/assistant-ui/src/deeply/nested/directories/for/testing/composer-effort-control.tsx';
    const summary = extractPrimaryArg({ path: longPath }, undefined);
    const display = summary?.display;
    expect(display).toHaveLength(64);
    expect(display).toContain('…');
    // The tail (basename) survives; the head keeps the path root.
    expect(display?.endsWith('composer-effort-control.tsx')).toBe(true);
    expect(display?.startsWith('packages/assistant-ui/')).toBe(true);
    // Ellipsis is in the middle, not at the end.
    expect(display?.endsWith('…')).toBe(false);
    expect(summary?.full).toBe(longPath);
  });

  it('treats Windows separators and spaced directories under path keys as paths', () => {
    const windowsPath = String.raw`C:\Users\sean\Documents\My Project\deeply\nested\workspace folders\composer-effort-control.tsx`;
    const summary = extractPrimaryArg({ filePath: windowsPath }, undefined);
    expect(summary?.display).toHaveLength(64);
    // Basename survives even though the path contains spaces + backslashes.
    expect(summary?.display.endsWith('composer-effort-control.tsx')).toBe(true);
    expect(summary?.display.endsWith('…')).toBe(false);

    const spacedPosixPath = `/Users/sean/Documents/My Project/${'nested dir/'.repeat(6)}notes file.md`;
    const spacedSummary = extractPrimaryArg({ path: spacedPosixPath }, undefined);
    expect(spacedSummary?.display.endsWith('notes file.md')).toBe(true);
  });

  it('never splits a surrogate pair at a truncation seam', () => {
    const emojiQuery = `${'🧠'.repeat(80)} trailing prose`;
    const summary = extractPrimaryArg({ query: emojiQuery }, undefined);
    expect(summary?.display).not.toContain('\uFFFD');
    // Cap counts CODE POINTS, so 63 emoji + ellipsis.
    expect([...(summary?.display ?? '')]).toHaveLength(64);

    const emojiPath = `packages/📁-assets/${'🧠'.repeat(60)}/notes.md`;
    const pathSummary = extractPrimaryArg({ path: emojiPath }, undefined);
    expect(pathSummary?.display.endsWith('notes.md')).toBe(true);
    expect(pathSummary?.display).not.toContain('\uFFFD');
  });

  it('preserves surrogate pairs at both path truncation boundaries', () => {
    const path = `${'🧠'.repeat(30)}/${'segment/'.repeat(20)}${'📁'.repeat(45)}`;
    const summary = extractPrimaryArg({ path }, undefined);
    const displayCodePoints = [...(summary?.display ?? '')];

    expect(displayCodePoints).toHaveLength(64);
    expect(displayCodePoints[24]).toBe('…');
    expect(summary?.display).not.toContain('\uFFFD');
    expect(summary?.full).toBe(path);
  });

  it('never exceeds the cap for any long value', () => {
    for (const value of [
      '/'.repeat(300),
      `a${' b'.repeat(200)}`,
      `${'segment/'.repeat(40)}file.ts`,
    ]) {
      const summary = extractPrimaryArg({ path: value }, undefined);
      expect((summary?.display ?? '').length).toBeLessThanOrEqual(64);
    }
  });
});

describe('ToolFallback', () => {
  const mockBaseProps = {
    addResult: () => {},
    args: { input: 'test' },
    argsText: '{"input":"test"}',
    part: {},
    respondToApproval: () => {},
    resume: () => {},
    status: { type: 'complete' as const },
    toolCallId: 'test-call-id',
    toolName: 'testTool',
    type: 'tool-call' as const,
  };

  describe('Running State', () => {
    it('displays running status with the shared thinking indicator', () => {
      wrap(<ToolFallback {...mockBaseProps} result={undefined} status={{ type: 'running' }} />);

      expect(screen.getByText(/testTool/)).toBeInTheDocument();
      expect(screen.getByLabelText(/Running/)).toBeInTheDocument();
      expect(
        screen.getByLabelText(/Running/).querySelector('.lucide-circle-dashed')
      ).not.toBeNull();
      // BST-849: the in-flight row reads its live progress, not a static
      // "Thinking" — with no streaming state or timing on the props it is
      // plain "Running".
      expect(screen.getByTestId('assistant-thinking-indicator')).toHaveTextContent('Running');
      expect(screen.getByTestId('assistant-thinking-mark')).toHaveAttribute(
        'data-tone',
        'greyscale'
      );
      expect(screen.getAllByTestId('assistant-thinking-mark')).toHaveLength(1);
      expect(screen.queryByRole('button')).not.toBeInTheDocument(); // No collapse button while running
    });
  });

  describe('Success State', () => {
    it('displays success status with checkmark', () => {
      wrap(
        <ToolFallback
          {...mockBaseProps}
          result={{ data: 'success' }}
          status={{ type: 'complete' }}
        />
      );

      expect(screen.getByText(/testTool/)).toBeInTheDocument();
      expect(screen.getByLabelText(/Completed/)).toBeInTheDocument();
    });

    it('shows the truncated arg while the hover title keeps the full value', () => {
      const longQuery = `find every reference to the composer control dock ${'x'.repeat(80)}`;
      wrap(
        <ToolFallback
          {...mockBaseProps}
          args={{ query: longQuery }}
          argsText={JSON.stringify({ query: longQuery })}
          status={{ type: 'complete' }}
        />
      );

      const argSpan = screen.getByTitle(longQuery);
      expect(argSpan.textContent).toHaveLength(64);
      expect(argSpan.textContent?.endsWith('…')).toBe(true);
    });

    it('surfaces the resolved workspace root from a native tool result', () => {
      wrap(
        <ToolFallback
          {...mockBaseProps}
          result={{ path: '/README.md', rootName: 'ProjectA' }}
          status={{ type: 'complete' }}
        />
      );

      expect(screen.getByText('in ProjectA')).toHaveAttribute(
        'title',
        'Resolved workspace root: ProjectA'
      );
    });

    it('keeps details hidden by default until expanded', async () => {
      const user = userEvent.setup();
      wrap(
        <ToolFallback
          {...mockBaseProps}
          argsText='{"input":"test value"}'
          result={{ data: 'result value' }}
          status={{ type: 'complete' }}
        />
      );

      expect(screen.queryByText(/Arguments:/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Result:/)).not.toBeInTheDocument();

      const expandButton = screen.getByRole('button', { name: /expand details/i });
      await user.click(expandButton);

      expect(screen.getByText(/Arguments:/)).toBeInTheDocument();
      expect(screen.getByText(/"input":"test value"/)).toBeInTheDocument();
      expect(screen.getByText(/Result:/)).toBeInTheDocument();
      expect(screen.getByText(/result value/)).toBeInTheDocument();
    });

    it('can expand details after collapsing', async () => {
      const user = userEvent.setup();
      wrap(
        <ToolFallback
          {...mockBaseProps}
          argsText='{"input":"test"}'
          result="success"
          status={{ type: 'complete' }}
        />
      );

      const expandButton = screen.getByRole('button', { name: /expand details/i });
      await user.click(expandButton);
      expect(screen.getByText(/Arguments:/)).toBeInTheDocument();

      const collapseButton = screen.getByRole('button', { name: /collapse details/i });
      await user.click(collapseButton);
      expect(screen.queryByText(/Arguments:/)).not.toBeInTheDocument();
    });
  });

  describe('Error State', () => {
    it('displays error status with alert icon', () => {
      wrap(
        <ToolFallback
          {...mockBaseProps}
          status={{
            error: 'Connection failed',
            reason: 'error',
            type: 'incomplete',
          }}
        />
      );

      expect(screen.getByText(/testTool/)).toBeInTheDocument();
      expect(screen.getByLabelText(/Failed/)).toBeInTheDocument();
    });

    it('shows error message from status.error', () => {
      wrap(
        <ToolFallback
          {...mockBaseProps}
          status={{
            error: 'Not connected',
            reason: 'error',
            type: 'incomplete',
          }}
        />
      );

      expect(screen.getByText('Not connected')).toBeInTheDocument();
    });

    it('shows tool-result errors as failed tool cards', () => {
      wrap(
        <ToolFallback
          {...mockBaseProps}
          result={{ error: 'Select an active embedding set to enable retrieval.' }}
          status={{ type: 'complete' }}
        />
      );

      expect(screen.getByLabelText(/Failed/)).toBeInTheDocument();
      expect(
        screen.getByText('Select an active embedding set to enable retrieval.')
      ).toBeInTheDocument();
    });

    it('shows error message from result when status.error is not a string', () => {
      wrap(
        <ToolFallback
          {...mockBaseProps}
          result="Database connection failed"
          status={{
            error: { code: 500 },
            reason: 'error',
            type: 'incomplete',
          }}
        />
      );

      // Should stringify the error object
      expect(screen.getByText(/code/)).toBeInTheDocument();
      expect(screen.getByText(/500/)).toBeInTheDocument();
    });

    it('shows default error message when no specific error is provided', () => {
      wrap(
        <ToolFallback
          {...mockBaseProps}
          status={{
            reason: 'other',
            type: 'incomplete',
          }}
        />
      );

      expect(screen.getByText(/Tool incomplete: other/)).toBeInTheDocument();
    });

    it('applies error styling', () => {
      const { container } = wrap(
        <ToolFallback
          {...mockBaseProps}
          status={{
            error: 'Test error',
            reason: 'error',
            type: 'incomplete',
          }}
        />
      );

      const errorContainer = container.querySelector('[data-testid="tool-fallback"]');
      expect(errorContainer).toHaveClass('border-destructive/50');
      expect(errorContainer).toHaveClass('bg-destructive/5');
    });

    it('shows args for error state after expanding', async () => {
      const user = userEvent.setup();
      wrap(
        <ToolFallback
          {...mockBaseProps}
          argsText='{"param":"value"}'
          status={{
            error: 'Failed to execute',
            reason: 'error',
            type: 'incomplete',
          }}
        />
      );

      expect(screen.queryByText(/Arguments:/)).not.toBeInTheDocument();

      const expandButton = screen.getByRole('button', { name: /expand details/i });
      await user.click(expandButton);

      expect(screen.getByText(/Arguments:/)).toBeInTheDocument();
      expect(screen.getByText(/"param":"value"/)).toBeInTheDocument();
      expect(screen.queryByText(/Result:/)).not.toBeInTheDocument();

      const collapseButton = screen.getByRole('button', { name: /collapse details/i });
      await user.click(collapseButton);
      expect(screen.queryByText(/Arguments:/)).not.toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('handles missing argsText', () => {
      wrap(
        <ToolFallback
          {...mockBaseProps}
          argsText=""
          result="success"
          status={{ type: 'complete' }}
        />
      );

      expect(screen.getByText(/testTool/)).toBeInTheDocument();
      expect(screen.getByLabelText(/Completed/)).toBeInTheDocument();
    });

    it('handles missing result and args', () => {
      wrap(
        <ToolFallback
          {...mockBaseProps}
          argsText=""
          result={undefined}
          status={{ type: 'complete' }}
        />
      );

      expect(screen.getByText(/testTool/)).toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument(); // No expand button without result or args
    });

    it('handles object result by stringifying after expanding', async () => {
      const user = userEvent.setup();
      wrap(
        <ToolFallback
          {...mockBaseProps}
          result={{ complex: { nested: 'value' } }}
          status={{ type: 'complete' }}
        />
      );

      await user.click(screen.getByRole('button', { name: /expand details/i }));
      expect(screen.getByText(/Result:/)).toBeInTheDocument();
      expect(screen.getByText(/complex/)).toBeInTheDocument();
      expect(screen.getByText(/nested/)).toBeInTheDocument();
    });

    it('handles string result after expanding', async () => {
      const user = userEvent.setup();
      wrap(
        <ToolFallback
          {...mockBaseProps}
          result="Simple string result"
          status={{ type: 'complete' }}
        />
      );

      await user.click(screen.getByRole('button', { name: /expand details/i }));
      expect(screen.getByText(/Result:/)).toBeInTheDocument();
      expect(screen.getByText('Simple string result')).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('has proper ARIA labels for the initial expand button', () => {
      wrap(
        <ToolFallback
          {...mockBaseProps}
          argsText='{"test":"value"}'
          result="success"
          status={{ type: 'complete' }}
        />
      );

      const button = screen.getByRole('button', { name: /expand details/i });
      expect(button).toHaveAttribute('aria-label', 'Expand details');
    });

    it('updates ARIA label after expanding', async () => {
      const user = userEvent.setup();
      wrap(
        <ToolFallback
          {...mockBaseProps}
          argsText='{"test":"value"}'
          result="success"
          status={{ type: 'complete' }}
        />
      );

      const expandButton = screen.getByRole('button', { name: /expand details/i });
      await user.click(expandButton);

      const collapseButton = screen.getByRole('button', { name: /collapse details/i });
      expect(collapseButton).toHaveAttribute('aria-label', 'Collapse details');
    });

    it('has identifiable test id', () => {
      const { container } = wrap(<ToolFallback {...mockBaseProps} status={{ type: 'complete' }} />);

      expect(container.querySelector('[data-testid="tool-fallback"]')).toBeInTheDocument();
    });
  });
});
