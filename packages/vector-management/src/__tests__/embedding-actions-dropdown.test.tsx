import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EmbeddingActionsDropdown,
  type EmbeddingActionsDropdownProps,
} from '../embedding-actions-dropdown';

describe('EmbeddingActionsDropdown', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const defaultProps: EmbeddingActionsDropdownProps = {
    backfilling: false,
    backfillProgress: null,
    coverage: { total: 100, withSet: 50 },
    failedCount: 0,
    hasDb: true,
    onBackfill: vi.fn(),
    onClearQueue: vi.fn(),
    onRetryFailed: vi.fn(),
    onWipeQueue: vi.fn(),
    queueCounts: { queued: 0, running: 0 },
  };

  const renderDropdown = (props: Partial<EmbeddingActionsDropdownProps> = {}) =>
    render(<EmbeddingActionsDropdown {...defaultProps} {...props} />);

  describe('Primary backfill button', () => {
    it('renders backfill button', () => {
      renderDropdown();
      expect(screen.getByRole('button', { name: 'Backfill' })).toBeInTheDocument();
    });

    it('calls onBackfill when clicked', async () => {
      const user = userEvent.setup();
      const onBackfill = vi.fn().mockResolvedValue(undefined);
      renderDropdown({ onBackfill });

      await user.click(screen.getByRole('button', { name: 'Backfill' }));

      await waitFor(() => {
        expect(onBackfill).toHaveBeenCalledTimes(1);
      });
    });

    it('does not leak rejected backfill clicks as unhandled promise rejections', async () => {
      const user = userEvent.setup();
      const onBackfill = vi.fn().mockRejectedValue(new Error('boom'));
      const onUnhandledRejection = vi.fn((event: PromiseRejectionEvent) => {
        event.preventDefault();
      });
      window.addEventListener('unhandledrejection', onUnhandledRejection);
      renderDropdown({ onBackfill });

      try {
        await user.click(screen.getByRole('button', { name: 'Backfill' }));

        await waitFor(() => {
          expect(onBackfill).toHaveBeenCalledTimes(1);
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(onUnhandledRejection).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener('unhandledrejection', onUnhandledRejection);
      }
    });

    it('is disabled when hasDb is false', () => {
      renderDropdown({ hasDb: false });
      expect(screen.getByRole('button', { name: 'Backfill' })).toBeDisabled();
    });

    it('is disabled when backfilling is true', () => {
      renderDropdown({ backfilling: true });
      expect(screen.getByRole('button', { name: 'Backfilling…' })).toBeDisabled();
    });

    it('is disabled when startingWorker is true', () => {
      renderDropdown({ startingWorker: true });
      expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();
    });

    it('is disabled when disabled prop is true', () => {
      renderDropdown({ disabled: true });
      expect(screen.getByRole('button', { name: 'Backfill' })).toBeDisabled();
    });
  });

  describe('Button text states', () => {
    it('shows "Backfill" in default state', () => {
      renderDropdown();
      expect(screen.getByRole('button', { name: 'Backfill' })).toBeInTheDocument();
    });

    it('shows "Starting…" when worker is starting', () => {
      renderDropdown({ startingWorker: true });
      expect(screen.getByRole('button', { name: 'Starting…' })).toBeInTheDocument();
    });

    it('shows "Backfilling…" when backfilling without progress', () => {
      renderDropdown({ backfilling: true, backfillProgress: null });
      expect(screen.getByRole('button', { name: 'Backfilling…' })).toBeInTheDocument();
    });

    it('shows progress while backfilling when progress is available', () => {
      renderDropdown({ backfilling: true, backfillProgress: { done: 25, total: 100 } });
      expect(screen.getByRole('button', { name: '25/100' })).toBeInTheDocument();
    });

    it('prioritizes backfilling progress over starting state', () => {
      renderDropdown({
        backfilling: true,
        backfillProgress: { done: 25, total: 100 },
        startingWorker: true,
      });
      expect(screen.getByRole('button', { name: '25/100' })).toBeInTheDocument();
    });

    it('shows "Start & Backfill" when willAutoStartWorker is true', () => {
      renderDropdown({ willAutoStartWorker: true });
      expect(screen.getByRole('button', { name: 'Start & Backfill' })).toBeInTheDocument();
    });
  });

  describe('Dropdown menu', () => {
    it('renders dropdown trigger', () => {
      renderDropdown();
      expect(screen.getByRole('button', { name: 'More embedding actions' })).toBeInTheDocument();
    });

    it('dropdown trigger is disabled when hasDb is false', () => {
      renderDropdown({ hasDb: false });
      expect(screen.getByRole('button', { name: 'More embedding actions' })).toBeDisabled();
    });

    it('opens dropdown menu when trigger is clicked', async () => {
      const user = userEvent.setup();
      renderDropdown();

      await user.click(screen.getByRole('button', { name: 'More embedding actions' }));

      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: /retry failed/i })).toBeInTheDocument();
      });
    });
  });

  describe('Retry Failed action', () => {
    it('shows retry failed menu item', async () => {
      const user = userEvent.setup();
      renderDropdown({ failedCount: 5 });

      await user.click(screen.getByRole('button', { name: 'More embedding actions' }));

      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: /retry failed/i })).toBeInTheDocument();
        expect(screen.getByText('(5)')).toBeInTheDocument();
      });
    });

    it('names the retry action as stalled recovery when failed jobs are blocking queued work', async () => {
      const user = userEvent.setup();
      renderDropdown({ failedCount: 5, queueCounts: { queued: 5, running: 0 } });

      await user.click(screen.getByRole('button', { name: 'More embedding actions' }));

      expect(
        await screen.findByRole('menuitem', { name: /retry failed & stalled/i })
      ).toBeVisible();
    });

    it('calls onRetryFailed when clicked', async () => {
      const user = userEvent.setup();
      const onRetryFailed = vi.fn().mockResolvedValue(undefined);
      renderDropdown({ failedCount: 3, onRetryFailed });

      await user.click(screen.getByRole('button', { name: 'More embedding actions' }));

      // Use findByRole (has built-in waiting) then click once
      const menuItem = await screen.findByRole('menuitem', { name: /retry failed/i });
      await user.click(menuItem);

      await waitFor(() => {
        expect(onRetryFailed).toHaveBeenCalledTimes(1);
      });
    });

    it('does not leak rejected retry clicks as unhandled promise rejections', async () => {
      const user = userEvent.setup();
      const onRetryFailed = vi.fn().mockRejectedValue(new Error('retry failed'));
      const onUnhandledRejection = vi.fn((event: PromiseRejectionEvent) => {
        event.preventDefault();
      });
      window.addEventListener('unhandledrejection', onUnhandledRejection);
      renderDropdown({ failedCount: 3, onRetryFailed });

      try {
        await user.click(screen.getByRole('button', { name: 'More embedding actions' }));
        await user.click(await screen.findByRole('menuitem', { name: /retry failed/i }));
        await waitFor(() => {
          expect(onRetryFailed).toHaveBeenCalledTimes(1);
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(onUnhandledRejection).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener('unhandledrejection', onUnhandledRejection);
      }
    });

    it('is disabled when failedCount is 0', async () => {
      const user = userEvent.setup();
      renderDropdown({ failedCount: 0 });

      await user.click(screen.getByRole('button', { name: 'More embedding actions' }));

      await waitFor(() => {
        const menuItem = screen.getByRole('menuitem', { name: /retry failed/i });
        expect(menuItem).toHaveAttribute('aria-disabled', 'true');
      });
    });

    it('is disabled when hasDb is false', () => {
      renderDropdown({ hasDb: false });

      // Dropdown trigger itself is disabled, so we can't open the menu
      expect(screen.getByRole('button', { name: 'More embedding actions' })).toBeDisabled();
    });
  });

  describe('Clear Queue action', () => {
    it('calls onClearQueue when clicked', async () => {
      const user = userEvent.setup();
      const onClearQueue = vi.fn().mockResolvedValue(undefined);
      renderDropdown({ onClearQueue });

      await user.click(screen.getByRole('button', { name: 'More embedding actions' }));

      // Use findByRole (has built-in waiting) then click once
      const menuItem = await screen.findByRole('menuitem', { name: /clear queue/i });
      await user.click(menuItem);

      await waitFor(() => {
        expect(onClearQueue).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Wipe All Jobs action', () => {
    it('shows wipe all jobs menu item', async () => {
      const user = userEvent.setup();
      renderDropdown();

      await user.click(screen.getByRole('button', { name: 'More embedding actions' }));

      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: /wipe all jobs/i })).toBeInTheDocument();
      });
    });

    it('calls onWipeQueue when clicked', async () => {
      const user = userEvent.setup();
      const onWipeQueue = vi.fn().mockResolvedValue(undefined);
      renderDropdown({ onWipeQueue });

      await user.click(screen.getByRole('button', { name: 'More embedding actions' }));

      // Use findByRole (has built-in waiting) then click once
      const menuItem = await screen.findByRole('menuitem', { name: /wipe all jobs/i });
      await user.click(menuItem);

      await waitFor(() => {
        expect(onWipeQueue).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Tooltip content', () => {
    it('shows custom disabled reason', async () => {
      const user = userEvent.setup();
      renderDropdown({
        disabled: true,
        disabledReason: 'API key required for this model',
      });

      // When disabled, the button is wrapped in a span with the TooltipTrigger
      // We need to hover on the span wrapper (parent of the button)
      const button = screen.getByRole('button', { name: 'Backfill' });
      const tooltipTrigger = button.closest('span.inline-flex') ?? button;
      await user.hover(tooltipTrigger);

      // Radix UI renders tooltip with role="tooltip"
      const tooltip = await screen.findByRole('tooltip');
      expect(tooltip).toHaveTextContent('API key required for this model');
    });

    it('shows "Database not available" when hasDb is false', async () => {
      const user = userEvent.setup();
      renderDropdown({ hasDb: false });

      // When hasDb is false, button is disabled and wrapped in span
      const button = screen.getByRole('button', { name: 'Backfill' });
      const tooltipTrigger = button.closest('span.inline-flex') ?? button;
      await user.hover(tooltipTrigger);

      // Radix UI renders tooltip with role="tooltip"
      const tooltip = await screen.findByRole('tooltip');
      expect(tooltip).toHaveTextContent('Database not available');
    });
  });

  describe('className prop', () => {
    it('applies custom className to container', () => {
      const { container } = renderDropdown({ className: 'custom-class' });
      expect(container.querySelector('.custom-class')).toBeInTheDocument();
    });
  });
});
