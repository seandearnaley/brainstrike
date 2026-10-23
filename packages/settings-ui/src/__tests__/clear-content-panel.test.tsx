import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ClearContentPanel } from '../settings/system/clear-content-panel';

describe('Clear content', () => {
  it('asks first, then clears chats and folders while keeping settings', async () => {
    const order: string[] = [];
    const clear = vi.fn(async () => {
      order.push('clear');
      return { deletedChunks: 0, deletedFiles: 0 };
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

  it('says why clearing failed', async () => {
    render(
      <ClearContentPanel
        clearContent={async () => {
          throw new Error('Content clearing did not return its completion receipt.');
        }}
        prepare={async () => {}}
        retireContent={() => {}}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear content…' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear content' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('completion receipt');
  });
});
