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

    it('shows expanded details with args and result by default', async () => {
      const user = userEvent.setup();
      render(
        <ToolFallback
          {...mockBaseProps}
          argsText='{"input":"test value"}'
          result={{ data: 'result value' }}
          status={{ type: 'complete' }}
        />
      );

      // Initially expanded (default state)
      expect(screen.getByText(/Arguments:/)).toBeInTheDocument();
      expect(screen.getByText(/"input":"test value"/)).toBeInTheDocument();
      expect(screen.getByText(/Result:/)).toBeInTheDocument();
      expect(screen.getByText(/result value/)).toBeInTheDocument();

      // Click to collapse
      const collapseButton = screen.getByRole('button', { name: /collapse details/i });
      await user.click(collapseButton);

      // Now details are hidden
      expect(screen.queryByText(/Arguments:/)).not.toBeInTheDocument();
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

      // Start expanded
      expect(screen.getByText(/Arguments:/)).toBeInTheDocument();

      // Collapse
      const collapseButton = screen.getByRole('button', { name: /collapse details/i });
      await user.click(collapseButton);
      expect(screen.queryByText(/Arguments:/)).not.toBeInTheDocument();

      // Expand again
      const expandButton = screen.getByRole('button', { name: /expand details/i });
      await user.click(expandButton);
      expect(screen.getByText(/Arguments:/)).toBeInTheDocument();
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

    it('shows args for error state (expanded by default)', async () => {
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

      // Should be expanded by default
      expect(screen.getByText(/Arguments:/)).toBeInTheDocument();
      expect(screen.getByText(/"param":"value"/)).toBeInTheDocument();
      // Error result should not be shown in the result section
      expect(screen.queryByText(/Result:/)).not.toBeInTheDocument();

      // Can collapse
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

    it('handles object result by stringifying (expanded by default)', async () => {
      render(
        <ToolFallback
          {...mockBaseProps}
          result={{ complex: { nested: 'value' } }}
          status={{ type: 'complete' }}
        />
      );

      // Already expanded by default
      expect(screen.getByText(/Result:/)).toBeInTheDocument();
      expect(screen.getByText(/complex/)).toBeInTheDocument();
      expect(screen.getByText(/nested/)).toBeInTheDocument();
    });

    it('handles string result (expanded by default)', async () => {
      render(
        <ToolFallback
          {...mockBaseProps}
          result="Simple string result"
          status={{ type: 'complete' }}
        />
      );

      // Already expanded by default
      expect(screen.getByText(/Result:/)).toBeInTheDocument();
      expect(screen.getByText('Simple string result')).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('has proper ARIA labels for collapse button (starts expanded)', () => {
      render(
        <ToolFallback
          {...mockBaseProps}
          argsText='{"test":"value"}'
          result="success"
          status={{ type: 'complete' }}
        />
      );

      const button = screen.getByRole('button', { name: /collapse details/i });
      expect(button).toHaveAttribute('aria-label', 'Collapse details');
    });

    it('updates ARIA label when expanding after collapse', async () => {
      const user = userEvent.setup();
      render(
        <ToolFallback
          {...mockBaseProps}
          argsText='{"test":"value"}'
          result="success"
          status={{ type: 'complete' }}
        />
      );

      // First collapse
      const collapseButton = screen.getByRole('button', { name: /collapse details/i });
      await user.click(collapseButton);

      // Then check expand button label
      const expandButton = screen.getByRole('button', { name: /expand details/i });
      expect(expandButton).toHaveAttribute('aria-label', 'Expand details');
    });

    it('has identifiable test id', () => {
      const { container } = render(
        <ToolFallback {...mockBaseProps} status={{ type: 'complete' }} />
      );

      expect(container.querySelector('[data-testid="tool-fallback"]')).toBeInTheDocument();
    });
  });
});
