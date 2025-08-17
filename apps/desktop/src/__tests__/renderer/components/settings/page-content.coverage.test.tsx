import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// Mock BaseSettingsPageContent to render headings similar to the real component
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

describe('SettingsPageContent (coverage)', () => {
  it('renders desktop-specific section content', () => {
    render(<SettingsPageContent />);

    // Verify desktop-specific section renders
    expect(
      screen.getByRole('heading', { name: 'Desktop Preferences', level: 2 })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Desktop-specific settings will be implemented here/i)
    ).toBeInTheDocument();
  });
});
