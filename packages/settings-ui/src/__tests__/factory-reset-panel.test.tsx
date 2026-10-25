import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FactoryResetPanel } from '../settings/system/factory-reset-panel';

type ResetLocal = () => Promise<{ message?: string; success: boolean }>;

function installDesktopReset(resetLocal: ResetLocal | undefined) {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: resetLocal ? { factoryReset: { resetLocal } } : undefined,
    writable: true,
  });
}

describe('FactoryResetPanel', () => {
  let confirm: Mock<(message?: string) => boolean>;

  beforeEach(() => {
    installDesktopReset(undefined);
    confirm = vi.fn<(message?: string) => boolean>(() => true);
    window.confirm = confirm;
  });

  it('is unavailable without the desktop reset and offers no other path', () => {
    render(<FactoryResetPanel />);
    expect(
      screen.getByText(
        /Factory reset is unavailable until the database is ready\. Restart the app if this does not clear\./
      )
    ).toBeVisible();
    const button = screen.getByTestId('factory-reset-button');
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('says what it deletes and that the app restarts, and does nothing when cancelled', () => {
    const resetLocal = vi.fn<ResetLocal>(async () => ({ success: true }));
    installDesktopReset(resetLocal);
    confirm.mockReturnValue(false);
    render(<FactoryResetPanel />);
    expect(screen.queryByText(/unavailable until the database is ready/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('factory-reset-button'));
    expect(confirm).toHaveBeenCalledWith(
      'Factory Reset will irreversibly delete local files, chunks, embeddings, queues, stored folders, API keys, tool settings, model/runtime caches, and UI state from this device. Diagnostic logs may be preserved. Brainstrike restarts to finish. Continue?'
    );
    expect(resetLocal).not.toHaveBeenCalled();
  });

  it('stays disabled once the app has accepted the reset and is quitting', async () => {
    const accepted = Promise.withResolvers<{ success: boolean }>();
    const resetLocal = vi.fn<ResetLocal>(() => accepted.promise);
    installDesktopReset(resetLocal);
    render(<FactoryResetPanel />);
    const button = screen.getByTestId('factory-reset-button');
    fireEvent.click(button);
    expect(button).toBeDisabled();
    accepted.resolve({ success: true });
    await accepted.promise;
    expect(button).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(resetLocal).toHaveBeenCalledOnce();
  });

  it('shows why a refused reset did not start and lets the user try again', async () => {
    installDesktopReset(
      vi.fn<ResetLocal>(async () => ({
        message: 'Another Brainstrike process is finishing a factory reset of this data.',
        success: false,
      }))
    );
    render(<FactoryResetPanel />);
    fireEvent.click(screen.getByTestId('factory-reset-button'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Another Brainstrike process is finishing a factory reset of this data.'
    );
    expect(screen.getByTestId('factory-reset-button')).toBeEnabled();
  });

  it('shows a bridge failure', async () => {
    installDesktopReset(
      vi.fn<ResetLocal>(async () => {
        throw new Error('The desktop bridge closed');
      })
    );
    render(<FactoryResetPanel />);
    fireEvent.click(screen.getByTestId('factory-reset-button'));
    expect(await screen.findByRole('alert')).toHaveTextContent('The desktop bridge closed');
  });
});
