import '@testing-library/jest-dom/vitest';
import { act } from '@brainstrike/test-utils/react-act';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClearContentPanel } from '../settings/system/clear-content-panel';

describe('Clear content', () => {
  it('asks first, then clears chats and folders while keeping settings', async () => {
    const order: string[] = [];
    const clear = vi.fn(async () => {
      order.push('clear');
    });
    render(
      <ClearContentPanel
        clearContent={clear}
        prepare={async () => {
          order.push('prepare');
        }}
        retireContent={() => order.push('retire')}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear content…' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Settings, providers and keys stay.');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear content' }));
    });
    expect(order).toEqual(['prepare', 'retire', 'clear']);
  });

  describe('after preparation began', () => {
    const order: string[] = [];
    const noteReloadIntent = vi.fn(async (reason: string) => {
      order.push(`intent:${reason}`);
    });

    beforeEach(() => {
      order.length = 0;
      noteReloadIntent.mockClear();
      vi.stubGlobal('location', { ...window.location, reload: () => order.push('reload') });
      Object.defineProperty(window, 'desktopLifecycle', {
        configurable: true,
        value: { noteReloadIntent },
        writable: true,
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      Object.defineProperty(window, 'desktopLifecycle', {
        configurable: true,
        value: undefined,
        writable: true,
      });
    });

    async function failClear(failure: { clear?: Error; prepare?: Error }) {
      render(
        <ClearContentPanel
          clearContent={async () => {
            if (failure.clear) {
              throw failure.clear;
            }
          }}
          prepare={async () => {
            if (failure.prepare) {
              throw failure.prepare;
            }
          }}
          retireContent={() => {}}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: 'Clear content…' }));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Clear content' }));
      });
    }

    it('keeps the reason on screen and only offers Reload', async () => {
      await failClear({
        clear: new Error('Content clearing did not return its completion receipt.'),
      });
      expect(await screen.findByRole('alert')).toHaveTextContent('completion receipt');
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Clear content' })).toBeNull();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
      });
      expect(order).toEqual(['intent:content-clear-failed-after-preparation', 'reload']);
    });

    it('shows a late failure even if the dialog was dismissed while clearing', async () => {
      const pending = Promise.withResolvers<void>();
      render(
        <ClearContentPanel
          clearContent={() => pending.promise}
          prepare={async () => {}}
          retireContent={() => {}}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: 'Clear content…' }));
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Clear content' }));
      });
      expect(screen.getByRole('button', { name: 'Clearing…' })).toBeDisabled();
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      await act(async () => {
        pending.reject(new Error('Content clearing did not return its completion receipt.'));
        await pending.promise.catch(() => {});
      });
      expect(await screen.findByRole('alert')).toHaveTextContent('completion receipt');
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    });

    it('treats a failed preparation the same way', async () => {
      await failClear({ prepare: new Error('Factory reset renderer preparation failed') });
      expect(await screen.findByRole('alert')).toHaveTextContent('preparation failed');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
      });
      expect(order).toEqual(['intent:content-clear-failed-after-preparation', 'reload']);
    });

    it('still reloads when recording the reload intent fails', async () => {
      noteReloadIntent.mockRejectedValueOnce(new Error('lifecycle closed'));
      await failClear({ clear: new Error('Clear failed') });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
      });
      expect(order).toEqual(['reload']);
    });
  });
});
