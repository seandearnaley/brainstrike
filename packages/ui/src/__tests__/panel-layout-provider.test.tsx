import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  PanelLayoutProvider,
  type PanelLayoutState,
  usePanelLayout,
} from '../providers/panel-layout-provider';

const state: PanelLayoutState = {
  showConsole: false,
  showLeftPanel: true,
  showRightPanel: false,
  sizes: [30, 20, 25],
};

function TestConsumer() {
  const context = usePanelLayout();
  if (!context) {
    return <div data-testid="context-value">no context</div>;
  }
  const { setState, ...current } = context;
  return (
    <button
      data-testid="context-value"
      onClick={() => setState({ ...current, showConsole: true })}
      type="button"
    >
      {`${current.sizes.join(',')} left=${current.showLeftPanel}`}
    </button>
  );
}

describe('PanelLayoutProvider', () => {
  it('provides the controlled state to its children', () => {
    render(
      <PanelLayoutProvider controlledState={state} onChange={vi.fn()}>
        <TestConsumer />
      </PanelLayoutProvider>
    );

    expect(screen.getByTestId('context-value')).toHaveTextContent('30,20,25 left=true');
  });

  it('sends every write to onChange, the state owner', () => {
    const onChange = vi.fn();
    render(
      <PanelLayoutProvider controlledState={state} onChange={onChange}>
        <TestConsumer />
      </PanelLayoutProvider>
    );

    fireEvent.click(screen.getByTestId('context-value'));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ ...state, showConsole: true });
  });
});

describe('usePanelLayout', () => {
  it('returns null outside a provider', () => {
    render(<TestConsumer />);
    expect(screen.getByTestId('context-value')).toHaveTextContent('no context');
  });
});
