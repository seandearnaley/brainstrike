import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IdeLayout } from '../layout/ide-layout';
import { PanelLayoutProvider } from '../providers/panel-layout-provider';

function LayoutHarness() {
  return (
    <PanelLayoutProvider
      initialState={{
        sizes: [30, 50, 20],
        showConsole: false,
        showLeftPanel: true,
        showRightPanel: false,
      }}
    >
      <IdeLayout
        consoleContent={<div>Console</div>}
        leftPanelContent={<div>Left</div>}
        rightPanelContent={<div>Right</div>}
      >
        <div>Main</div>
      </IdeLayout>
    </PanelLayoutProvider>
  );
}

describe('PanelLayoutProvider integration', () => {
  it('uses provider state and toggles via IdeLayout controls', () => {
    render(<LayoutHarness />);

    // Left panel visible by default; hide it via button
    const hideLeft = screen.getByTestId('hide-left-panel');
    fireEvent.click(hideLeft);

    // Show-left shim should be visible after hiding
    expect(screen.getByTestId('show-left-panel')).toBeInTheDocument();

    // Show console via shim
    const showConsole = screen.getByTestId('show-console-panel');
    fireEvent.click(showConsole);

    // Console close button should appear
    expect(screen.getByTestId('hide-console-panel')).toBeInTheDocument();
  });
});
