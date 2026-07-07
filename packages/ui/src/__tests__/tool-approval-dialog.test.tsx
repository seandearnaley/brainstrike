/**
 * Tool Approval Dialog Tests
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ToolApprovalDialog,
  type ToolApprovalInfo,
  type ToolApprovalResult,
  useToolApproval,
} from '../tool-approval-dialog';

// Test wrapper component for hook testing
function TestHookComponent({
  onResult,
  skipApprovalFor,
}: {
  onResult: (result: ToolApprovalResult) => void;
  skipApprovalFor?: Set<string>;
}) {
  const hookOptions = skipApprovalFor ? { skipApprovalFor } : {};
  const { requestApproval, pendingTool, isPending, resolvePending } = useToolApproval(hookOptions);

  const testTool: ToolApprovalInfo = {
    description: 'A test tool',
    id: 'test.tool',
    input: { param1: 'value1' },
    name: 'Test Tool',
  };

  return (
    <div>
      <button
        data-testid="request-approval"
        onClick={() => requestApproval(testTool).then(onResult)}
        type="button"
      >
        Request Approval
      </button>
      <div data-testid="is-pending">{isPending ? 'true' : 'false'}</div>
      {pendingTool && (
        <ToolApprovalDialog onResult={resolvePending} open={true} tool={pendingTool} />
      )}
    </div>
  );
}

describe('ToolApprovalDialog', () => {
  const mockOnResult = vi.fn();

  const defaultTool: ToolApprovalInfo = {
    category: 'action',
    description: 'Creates a new embedding collection for storing document vectors.',
    id: 'brainstrike.createEmbeddingSet',
    input: {
      modelKey: 'openai::text-embedding-3-small',
      name: 'Test Collection',
    },
    name: 'Create Embedding Set',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  describe('rendering', () => {
    it('renders dialog with tool information', () => {
      render(<ToolApprovalDialog onResult={mockOnResult} open={true} tool={defaultTool} />);

      expect(screen.getByText('Confirm Tool Action')).toBeInTheDocument();
      expect(screen.getByText(defaultTool.id)).toBeInTheDocument();
      expect(screen.getByText(defaultTool.description)).toBeInTheDocument();
    });

    it('displays input parameters', () => {
      render(<ToolApprovalDialog onResult={mockOnResult} open={true} tool={defaultTool} />);

      expect(screen.getByText('name')).toBeInTheDocument();
      expect(screen.getByText('Test Collection')).toBeInTheDocument();
      expect(screen.getByText('modelKey')).toBeInTheDocument();
    });

    it('shows category badge when provided', () => {
      render(<ToolApprovalDialog onResult={mockOnResult} open={true} tool={defaultTool} />);

      expect(screen.getByText('action')).toBeInTheDocument();
    });

    it('shows custom title and description', () => {
      render(
        <ToolApprovalDialog
          description="Custom description"
          onResult={mockOnResult}
          open={true}
          title="Custom Title"
          tool={defaultTool}
        />
      );

      expect(screen.getByText('Custom Title')).toBeInTheDocument();
      expect(screen.getByText('Custom description')).toBeInTheDocument();
    });

    it('hides dont ask again checkbox when showDontAskAgain is false', () => {
      render(
        <ToolApprovalDialog
          onResult={mockOnResult}
          open={true}
          showDontAskAgain={false}
          tool={defaultTool}
        />
      );

      expect(screen.queryByText("Don't ask again for this tool")).not.toBeInTheDocument();
    });

    it('shows warning icon for high risk tools', () => {
      const highRiskTool: ToolApprovalInfo = {
        ...defaultTool,
        riskLevel: 'high',
      };

      render(<ToolApprovalDialog onResult={mockOnResult} open={true} tool={highRiskTool} />);

      // The destructive button should show "Proceed Anyway"
      expect(screen.getByText('Proceed Anyway')).toBeInTheDocument();
    });
  });

  describe('interactions', () => {
    it('calls onResult with approved=true when Approve is clicked', async () => {
      render(<ToolApprovalDialog onResult={mockOnResult} open={true} tool={defaultTool} />);

      const approveButton = screen.getByRole('button', { name: 'Approve' });
      fireEvent.click(approveButton);

      expect(mockOnResult).toHaveBeenCalledWith({
        approved: true,
        dontAskAgain: false,
      });
    });

    it('calls onResult with approved=false when Cancel is clicked', async () => {
      render(<ToolApprovalDialog onResult={mockOnResult} open={true} tool={defaultTool} />);

      const cancelButton = screen.getByRole('button', { name: 'Cancel' });
      fireEvent.click(cancelButton);

      expect(mockOnResult).toHaveBeenCalledWith({
        approved: false,
        dontAskAgain: false,
      });
    });

    it('includes dontAskAgain=true when checkbox is checked', async () => {
      render(<ToolApprovalDialog onResult={mockOnResult} open={true} tool={defaultTool} />);

      const checkbox = screen.getByRole('checkbox');
      fireEvent.click(checkbox);

      const approveButton = screen.getByRole('button', { name: 'Approve' });
      fireEvent.click(approveButton);

      expect(mockOnResult).toHaveBeenCalledWith({
        approved: true,
        dontAskAgain: true,
      });
    });
  });

  describe('value formatting', () => {
    it('truncates long string values', () => {
      const longValueTool: ToolApprovalInfo = {
        ...defaultTool,
        input: {
          longParam: 'a'.repeat(150),
        },
      };

      render(<ToolApprovalDialog onResult={mockOnResult} open={true} tool={longValueTool} />);

      // Should show truncated value with ellipsis
      expect(screen.getByText(/\.\.\.$/)).toBeInTheDocument();
    });

    it('displays array values as count', () => {
      const arrayTool: ToolApprovalInfo = {
        ...defaultTool,
        input: {
          items: [1, 2, 3, 4, 5],
        },
      };

      render(<ToolApprovalDialog onResult={mockOnResult} open={true} tool={arrayTool} />);

      expect(screen.getByText('[5 items]')).toBeInTheDocument();
    });

    it('displays null values', () => {
      const nullTool: ToolApprovalInfo = {
        ...defaultTool,
        input: {
          nullParam: null,
        },
      };

      render(<ToolApprovalDialog onResult={mockOnResult} open={true} tool={nullTool} />);

      expect(screen.getByText('null')).toBeInTheDocument();
    });
  });
});

describe('useToolApproval', () => {
  afterEach(() => {
    cleanup();
  });

  it('skips approval for tools in skipApprovalFor set', async () => {
    const onResult = vi.fn();
    const skipApprovalFor = new Set(['test.tool']);

    render(<TestHookComponent onResult={onResult} skipApprovalFor={skipApprovalFor} />);

    const requestButton = screen.getByTestId('request-approval');
    fireEvent.click(requestButton);

    await waitFor(() => {
      expect(onResult).toHaveBeenCalledWith({
        approved: true,
        dontAskAgain: true,
      });
    });
  });

  it('shows dialog for tools not in skipApprovalFor set', async () => {
    const onResult = vi.fn();

    render(<TestHookComponent onResult={onResult} />);

    const requestButton = screen.getByTestId('request-approval');
    fireEvent.click(requestButton);

    await waitFor(() => {
      expect(screen.getByTestId('is-pending').textContent).toBe('true');
    });

    // Dialog should be shown
    expect(screen.getByText('Confirm Tool Action')).toBeInTheDocument();
  });

  it('resolves approval when dialog approves', async () => {
    const onResult = vi.fn();

    render(<TestHookComponent onResult={onResult} />);

    fireEvent.click(screen.getByTestId('request-approval'));

    const approveButton = await screen.findByRole('button', { name: 'Approve' });
    fireEvent.click(approveButton);

    await waitFor(() => {
      expect(onResult).toHaveBeenCalledWith({
        approved: true,
        dontAskAgain: false,
      });
    });
  });

  it('queues multiple approval requests in order', async () => {
    const onResult = vi.fn();

    render(<TestHookComponent onResult={onResult} />);

    const requestButton = screen.getByTestId('request-approval');
    fireEvent.click(requestButton);
    fireEvent.click(requestButton);

    const approveButton = await screen.findByRole('button', { name: 'Approve' });
    fireEvent.click(approveButton);

    await waitFor(() => {
      expect(onResult).toHaveBeenCalledTimes(1);
    });

    const approveButtonAgain = await screen.findByRole('button', { name: 'Approve' });
    fireEvent.click(approveButtonAgain);

    await waitFor(() => {
      expect(onResult).toHaveBeenCalledTimes(2);
    });
  });
});
