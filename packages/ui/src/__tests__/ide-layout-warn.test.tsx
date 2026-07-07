import { render } from '@testing-library/react';

vi.mock('@brainstrike/utils/env-utils', () => ({
  isDevEnv: vi.fn(() => true),
}));

// Mock persistence hook used internally by IdeLayout
// sizes format: [leftPanelSize, rightPanelSize, consolePanelSize]
vi.mock('../hooks/use-panel-persistence', () => ({
  usePanelPersistence: vi.fn(() => ({
    saveLayout: vi.fn(),
    showConsole: false,
    showLeftPanel: true,
    showRightPanel: false,
    sizes: [25, 20, 20],
    toggleConsole: vi.fn(),
    toggleLeftPanel: vi.fn(),
    toggleRightPanel: vi.fn(),
  })),
}));

// Import after mocks
import { IdeLayout } from '../layout/ide-layout';

describe('IdeLayout Phase 2 strictness', () => {
  it('throws in dev when rendered without provider/controlled props', () => {
    // silence expected error output
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      render(
        <IdeLayout consoleContent={<div />} leftPanelContent={<div />} rightPanelContent={<div />}>
          <div>Content</div>
        </IdeLayout>
      )
    ).toThrow(/Missing PanelLayoutProvider/);

    errorSpy.mockRestore();
  });
});
