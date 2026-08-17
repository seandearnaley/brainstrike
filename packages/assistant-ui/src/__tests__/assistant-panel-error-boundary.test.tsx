import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AssistantPanelErrorBoundary } from '../assistant-panel-error-boundary';

function Boom(): never {
  throw new Error('render exploded');
}

describe('AssistantPanelErrorBoundary', () => {
  it('renders a recoverable fallback instead of a dead tree', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <AssistantPanelErrorBoundary>
        <Boom />
      </AssistantPanelErrorBoundary>
    );
    expect(screen.getByText(/assistant panel hit an error/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reset/i })).toBeInTheDocument();
    spy.mockRestore();
  });

  it('recovers after reset when children no longer throw', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let shouldThrow = true;
    function Maybe() {
      if (shouldThrow) {
        throw new Error('boom');
      }
      return <div>recovered</div>;
    }
    render(
      <AssistantPanelErrorBoundary>
        <Maybe />
      </AssistantPanelErrorBoundary>
    );
    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: /reset/i }));
    expect(screen.getByText('recovered')).toBeInTheDocument();
    spy.mockRestore();
  });
});
