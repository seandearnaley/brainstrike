import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ToolFallback } from '../assistant-ui-panel/tool-fallback';

describe('ToolFallback', () => {
  const mockBaseProps = {
    type: 'tool-call' as const,
    toolCallId: 'test-call-id',
    toolName: 'testTool',
    args: { input: 'test' },
    argsText: '{"input":"test"}',
    part: {},
    status: { type: 'complete' as const },
    addResult: () => {},
    resume: () => {},
  };

  describe('Running State', () => {
    it('displays running status with spinner', () => {
      render(<ToolFallback {...mockBaseProps} result={undefined} status={{ type: 'running' }} />);

      expect(screen.getByText(/testTool/)).toBeInTheDocument();
      expect(screen.getByText(/Running/)).toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument(); // No collapse button while running
    });
  });

  describe('Success State', () => {
    it('displays success status with checkmark', () => {
      render(
        <ToolFallback
          {...mockBaseProps}
          result={{ data: 'success' }}
          status={{ type: 'complete' }}
        />
      );

      expect(screen.getByText(/testTool/)).toBeInTheDocument();
      expect(screen.getByText(/Completed/)).toBeInTheDocument();
    });

    it('keeps details hidden by default until expanded', async () => {
      const user = userEvent.setup();
      render(
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
      render(
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
      render(
        <ToolFallback
          {...mockBaseProps}
          status={{
            type: 'incomplete',
            reason: 'error',
            error: 'Connection failed',
          }}
        />
      );

      expect(screen.getByText(/testTool/)).toBeInTheDocument();
      expect(screen.getByText(/Failed/)).toBeInTheDocument();
    });

    it('shows error message from status.error', () => {
      render(
        <ToolFallback
          {...mockBaseProps}
          status={{
            type: 'incomplete',
            reason: 'error',
            error: 'Not connected',
          }}
        />
      );

      expect(screen.getByText('Not connected')).toBeInTheDocument();
    });

    it('shows tool-result errors as failed tool cards', () => {
      render(
        <ToolFallback
          {...mockBaseProps}
          result={{ error: 'Select an active embedding set to enable retrieval.' }}
          status={{ type: 'complete' }}
        />
      );

      expect(screen.getByText(/Failed/)).toBeInTheDocument();
      expect(
        screen.getByText('Select an active embedding set to enable retrieval.')
      ).toBeInTheDocument();
    });

    it('shows error message from result when status.error is not a string', () => {
      render(
        <ToolFallback
          {...mockBaseProps}
          result="Database connection failed"
          status={{
            type: 'incomplete',
            reason: 'error',
            error: { code: 500 },
          }}
        />
      );

      // Should stringify the error object
      expect(screen.getByText(/code/)).toBeInTheDocument();
      expect(screen.getByText(/500/)).toBeInTheDocument();
    });

    it('shows default error message when no specific error is provided', () => {
      render(
        <ToolFallback
          {...mockBaseProps}
          status={{
            type: 'incomplete',
            reason: 'other',
          }}
        />
      );

      expect(screen.getByText(/Tool incomplete: other/)).toBeInTheDocument();
    });

    it('applies error styling', () => {
      const { container } = render(
        <ToolFallback
          {...mockBaseProps}
          status={{
            type: 'incomplete',
            reason: 'error',
            error: 'Test error',
          }}
        />
      );

      const errorContainer = container.querySelector('[data-testid="tool-fallback"]');
      expect(errorContainer).toHaveClass('border-destructive/50');
      expect(errorContainer).toHaveClass('bg-destructive/5');
    });

    it('shows args for error state after expanding', async () => {
      const user = userEvent.setup();
      render(
        <ToolFallback
          {...mockBaseProps}
          argsText='{"param":"value"}'
          status={{
            type: 'incomplete',
            reason: 'error',
            error: 'Failed to execute',
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
      render(
        <ToolFallback
          {...mockBaseProps}
          argsText=""
          result="success"
          status={{ type: 'complete' }}
        />
      );

      expect(screen.getByText(/testTool/)).toBeInTheDocument();
      expect(screen.getByText(/Completed/)).toBeInTheDocument();
    });

    it('handles missing result and args', () => {
      render(
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
      render(
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
      render(
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
      render(
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
      render(
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
      const { container } = render(
        <ToolFallback {...mockBaseProps} status={{ type: 'complete' }} />
      );

      expect(container.querySelector('[data-testid="tool-fallback"]')).toBeInTheDocument();
    });
  });
});
