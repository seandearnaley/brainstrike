import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ImportProgressBar } from '../import-progress-bar';

vi.mock('@brainstrike/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...actual,
    Progress: ({
      value,
      className,
      ...rest
    }: { value?: number; className?: string } & Record<string, unknown>) => (
      <div className={className} data-testid="progress-bar" {...rest}>
        {Math.round(value ?? 0)}%
      </div>
    ),
  };
});

describe('ImportProgressBar', () => {
  const baseProgress = {
    phase: 'importing' as const,
    total: 10,
    completed: 4,
    errors: [],
  };

  it('renders the spinning indicator with aria-hidden when in progress', () => {
    const { container } = render(<ImportProgressBar progress={baseProgress} />);
    expect(screen.getByText('Importing')).toBeInTheDocument();
    const spinner = container.querySelector('div.animate-spin') as HTMLElement | null;
    expect(spinner).not.toBeNull();
    expect(spinner).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders the cancelling pulse with aria-hidden', () => {
    const { container } = render(<ImportProgressBar isCancelling progress={baseProgress} />);
    expect(screen.getByText('Cancelling...')).toBeInTheDocument();
    const pulse = container.querySelector('div.animate-pulse') as HTMLElement | null;
    expect(pulse).not.toBeNull();
    expect(pulse).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders the CheckCircle indicator with aria-hidden when complete', () => {
    const { container } = render(
      <ImportProgressBar progress={{ ...baseProgress, completed: 10 }} />
    );
    expect(screen.getByText('Complete')).toBeInTheDocument();
    // lucide-react renders as <svg> with aria-hidden when set on the icon component
    const svgs = container.querySelectorAll('svg[aria-hidden="true"]');
    expect(svgs.length).toBeGreaterThanOrEqual(1);
  });

  it('renders aria-labels for files and chunks progress bars', () => {
    const progress = {
      ...baseProgress,
      chunkingProgress: {
        currentFile: 'a.ts',
        filesProcessed: 1,
        totalFiles: 4,
        chunksCreated: 9,
      },
    };
    render(<ImportProgressBar progress={progress} />);
    const bars = screen.getAllByTestId('progress-bar');
    const labels = bars.map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(
      expect.arrayContaining(['Files import progress', 'Chunks import progress'])
    );
  });

  it('renders the cancel button when not complete and not cancelling', () => {
    const onCancel = vi.fn();
    render(<ImportProgressBar onCancel={onCancel} progress={baseProgress} />);
    const cancel = screen.getByRole('button', { name: /cancel import/i });
    expect(cancel).toBeInTheDocument();
    cancel.click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders the close button only when complete', () => {
    const onClose = vi.fn();
    render(<ImportProgressBar onClose={onClose} progress={{ ...baseProgress, completed: 10 }} />);
    const close = screen.getByRole('button', { name: /close import progress/i });
    expect(close).toBeInTheDocument();
    close.click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
