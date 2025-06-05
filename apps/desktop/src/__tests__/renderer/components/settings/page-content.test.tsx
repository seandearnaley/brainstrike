import { ThemeProvider } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// Mock the app-shell components before importing
vi.mock('@brainstrike/app-shell', () => ({
  SettingsPageContent: ({ children }: { children?: React.ReactNode }) => (
    <div>
      <h1>Settings</h1>
      <h2>Appearance</h2>
      <div>theme-settings-mock</div>
      {children}
    </div>
  ),
}));

import SettingsPageContent from '../../../../renderer/components/settings/page-content';

describe('SettingsPageContent', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <ThemeProvider>
        <SettingsPageContent />
      </ThemeProvider>
    );

    // Just check that the component renders without throwing
    expect(container).toBeInTheDocument();
  });
});
