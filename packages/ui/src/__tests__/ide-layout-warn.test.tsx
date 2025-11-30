import { render } from '@testing-library/react';

// Mock dev environment BEFORE importing component
vi.mock('@brainstrike/utils', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/utils')>('@brainstrike/utils');
  return {
    ...actual,
    isDevEnv: vi.fn(() => true),
  };
});

// Mock persistence hook used internally by IdeLayout
vi.mock('../hooks/use-panel-persistence', () => ({
  usePanelPersistence: vi.fn(() => ({
    sizes: [25, 55, 20],
    showConsole: false,
    showLeftPanel: true,
    showRightPanel: false,
    saveLayout: vi.fn(),
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
