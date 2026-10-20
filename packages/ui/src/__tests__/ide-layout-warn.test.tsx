import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IdeLayout } from '../layout/ide-layout';

describe('IdeLayout without a PanelLayoutProvider', () => {
  it('throws, because the provider is the only source of panel state', () => {
    // silence expected error output
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      render(
        <IdeLayout consoleContent={<div />} leftPanelContent={<div />} rightPanelContent={<div />}>
          <div>Content</div>
        </IdeLayout>
      )
    ).toThrow(/IdeLayout must be rendered inside a PanelLayoutProvider/);

    errorSpy.mockRestore();
  });
});
