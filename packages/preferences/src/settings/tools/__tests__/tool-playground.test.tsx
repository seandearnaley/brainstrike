/**
 * Tool Playground Tests
 */

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolPlayground } from '../tool-playground';
import type { ToolExecutionResult } from '../types';

// Mock @brainstrike/ui
vi.mock('@brainstrike/ui', () => ({
  Badge: ({
    children,
    className,
    variant,
  }: {
    children: React.ReactNode;
    className?: string;
    variant?: string;
  }) => (
    <span className={className} data-variant={variant}>
      {children}
    </span>
  ),
  Button: ({
    children,
    disabled,
    onClick,
    'data-testid': testId,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick: () => void;
    'data-testid'?: string;
  }) => (
    <button data-testid={testId} disabled={disabled} onClick={onClick} type="button">
      {children}
    </button>
  ),
}));

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
})();

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
});

describe('ToolPlayground', () => {
  const mockOnExecute = vi.fn<(input: unknown) => Promise<ToolExecutionResult>>();

  beforeEach(() => {
    vi.clearAllMocks();
    localStorageMock.clear();
  });

  describe('rendering', () => {
    it('renders the playground with input and execute button', () => {
      render(<ToolPlayground onExecute={mockOnExecute} toolId="test.tool" />);

      expect(screen.getByTestId('tool-playground-test.tool')).toBeInTheDocument();
      expect(screen.getByTestId('json-input')).toBeInTheDocument();
      expect(screen.getByTestId('execute-button')).toBeInTheDocument();
      expect(screen.getByText('Run')).toBeInTheDocument();
    });

    it('renders with default empty JSON input', () => {
      render(<ToolPlayground onExecute={mockOnExecute} toolId="test.tool" />);

      const input = screen.getByTestId('json-input') as HTMLTextAreaElement;
      expect(input.value).toBe('{}');
    });

    it('loads stored input from localStorage', () => {
      localStorageMock.setItem('tool-playground-test.tool', '{"query": "test"}');

      render(<ToolPlayground onExecute={mockOnExecute} toolId="test.tool" />);

      const input = screen.getByTestId('json-input') as HTMLTextAreaElement;
      expect(input.value).toBe('{"query": "test"}');
    });

    it('removes aria-controls when the parameters panel is collapsed', () => {
      render(<ToolPlayground onExecute={mockOnExecute} toolId="brainstrike.readWorkspaceFile" />);

      const parametersButton = screen.getByRole('button', { name: /Parameters/ });
      expect(parametersButton).toHaveAttribute('aria-expanded', 'true');
      const expandedContentId = parametersButton.getAttribute('aria-controls');
      expect(expandedContentId).not.toBeNull();
      if (expandedContentId === null) {
        throw new Error('Expected expanded parameters button to control visible content');
      }
      expect(document.getElementById(expandedContentId)).toBeInTheDocument();

      fireEvent.click(parametersButton);

      expect(parametersButton).toHaveAttribute('aria-expanded', 'false');
      expect(parametersButton).not.toHaveAttribute('aria-controls');
      expect(document.getElementById(expandedContentId)).not.toBeInTheDocument();
    });
  });

  describe('input handling', () => {
    it('updates input value when typing', () => {
      render(<ToolPlayground onExecute={mockOnExecute} toolId="test.tool" />);

      const input = screen.getByTestId('json-input');
      fireEvent.change(input, { target: { value: '{"key": "value"}' } });

      expect((input as HTMLTextAreaElement).value).toBe('{"key": "value"}');
    });

    it('persists input to localStorage', () => {
      render(<ToolPlayground onExecute={mockOnExecute} toolId="test.tool" />);

      const input = screen.getByTestId('json-input');
      fireEvent.change(input, { target: { value: '{"stored": true}' } });

      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        'tool-playground-test.tool',
        '{"stored": true}'
      );
    });
  });

  describe('JSON validation', () => {
    it('shows parse error for invalid JSON', async () => {
      render(<ToolPlayground onExecute={mockOnExecute} toolId="test.tool" />);

      const input = screen.getByTestId('json-input');
      fireEvent.change(input, { target: { value: 'not valid json' } });

      const executeButton = screen.getByTestId('execute-button');
      fireEvent.click(executeButton);

      await waitFor(() => {
        expect(screen.getByTestId('parse-error')).toBeInTheDocument();
      });

      expect(mockOnExecute).not.toHaveBeenCalled();
    });

    it('clears parse error when input changes', async () => {
      render(<ToolPlayground onExecute={mockOnExecute} toolId="test.tool" />);

      const input = screen.getByTestId('json-input');

      // First, create a parse error
      fireEvent.change(input, { target: { value: 'invalid' } });
      fireEvent.click(screen.getByTestId('execute-button'));

      await waitFor(() => {
        expect(screen.getByTestId('parse-error')).toBeInTheDocument();
      });

      // Then, change the input
      fireEvent.change(input, { target: { value: '{}' } });

      expect(screen.queryByTestId('parse-error')).not.toBeInTheDocument();
    });
  });

  describe('execution', () => {
    it('executes with parsed JSON input', async () => {
      mockOnExecute.mockResolvedValue({
        success: true,
        result: { data: 'test' },
        durationMs: 100,
      });

      render(<ToolPlayground onExecute={mockOnExecute} toolId="test.tool" />);

      const input = screen.getByTestId('json-input');
      fireEvent.change(input, { target: { value: '{"query": "search"}' } });

      const executeButton = screen.getByTestId('execute-button');
      fireEvent.click(executeButton);

      await waitFor(() => {
        expect(mockOnExecute).toHaveBeenCalledWith({ query: 'search' });
      });
    });

    it('shows loading state during execution', async () => {
      let resolveExecution: (value: ToolExecutionResult) => void;
      mockOnExecute.mockReturnValue(
        new Promise((resolve) => {
          resolveExecution = resolve;
        })
      );

      render(<ToolPlayground onExecute={mockOnExecute} toolId="test.tool" />);

      const executeButton = screen.getByTestId('execute-button');
      fireEvent.click(executeButton);

      await waitFor(() => {
        expect(screen.getByText('Running...')).toBeInTheDocument();
        expect(executeButton).toBeDisabled();
      });

      // Resolve the promise
      resolveExecution!({
        success: true,
        result: {},
        durationMs: 50,
      });

      await waitFor(() => {
        expect(screen.getByText('Run')).toBeInTheDocument();
      });
    });

    it('displays success result', async () => {
      mockOnExecute.mockResolvedValue({
        success: true,
        result: { message: 'Hello World' },
        durationMs: 150,
      });

      render(<ToolPlayground onExecute={mockOnExecute} toolId="test.tool" />);

      fireEvent.click(screen.getByTestId('execute-button'));

      await waitFor(() => {
        expect(screen.getByTestId('execution-result')).toBeInTheDocument();
        expect(screen.getByText('Success')).toBeInTheDocument();
        expect(screen.getByText('150ms')).toBeInTheDocument();
        expect(screen.getByText(/"message": "Hello World"/)).toBeInTheDocument();
      });
    });

    it('displays error result', async () => {
      mockOnExecute.mockResolvedValue({
        success: false,
        error: 'Something went wrong',
        durationMs: 50,
      });

      render(<ToolPlayground onExecute={mockOnExecute} toolId="test.tool" />);

      fireEvent.click(screen.getByTestId('execute-button'));

      await waitFor(() => {
        expect(screen.getByTestId('execution-result')).toBeInTheDocument();
        expect(screen.getByText('Error')).toBeInTheDocument();
        expect(screen.getByText('Something went wrong')).toBeInTheDocument();
      });
    });

    it('handles execution exceptions gracefully', async () => {
      mockOnExecute.mockRejectedValue(new Error('Network error'));

      render(<ToolPlayground onExecute={mockOnExecute} toolId="test.tool" />);

      fireEvent.click(screen.getByTestId('execute-button'));

      await waitFor(() => {
        expect(screen.getByTestId('execution-result')).toBeInTheDocument();
        expect(screen.getByText('Error')).toBeInTheDocument();
        expect(screen.getByText('Network error')).toBeInTheDocument();
      });
    });

    it('clears previous result when executing again', async () => {
      mockOnExecute
        .mockResolvedValueOnce({
          success: true,
          result: { first: true },
          durationMs: 100,
        })
        .mockResolvedValueOnce({
          success: true,
          result: { second: true },
          durationMs: 200,
        });

      render(<ToolPlayground onExecute={mockOnExecute} toolId="test.tool" />);

      // First execution
      fireEvent.click(screen.getByTestId('execute-button'));

      await waitFor(() => {
        expect(screen.getByText(/"first": true/)).toBeInTheDocument();
      });

      // Second execution
      fireEvent.click(screen.getByTestId('execute-button'));

      await waitFor(() => {
        expect(screen.queryByText(/"first": true/)).not.toBeInTheDocument();
        expect(screen.getByText(/"second": true/)).toBeInTheDocument();
      });
    });
  });

  describe('result styling', () => {
    it('applies success styling for successful execution', async () => {
      mockOnExecute.mockResolvedValue({
        success: true,
        result: {},
        durationMs: 50,
      });

      render(<ToolPlayground onExecute={mockOnExecute} toolId="test.tool" />);

      fireEvent.click(screen.getByTestId('execute-button'));

      await waitFor(() => {
        const result = screen.getByTestId('execution-result');
        expect(result.className).toContain('border-green-500/50');
      });
    });

    it('applies error styling for failed execution', async () => {
      mockOnExecute.mockResolvedValue({
        success: false,
        error: 'Failed',
        durationMs: 50,
      });

      render(<ToolPlayground onExecute={mockOnExecute} toolId="test.tool" />);

      fireEvent.click(screen.getByTestId('execute-button'));

      await waitFor(() => {
        const result = screen.getByTestId('execution-result');
        expect(result.className).toContain('border-destructive/50');
      });
    });
  });
});
