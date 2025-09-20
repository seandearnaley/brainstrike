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
  it('renders desktop-specific section content', async () => {
    // Provide a stable secrets API to avoid act() warnings from async updates
    const globalWithWindow = global as typeof globalThis & { window?: Window };
    global.window = globalWithWindow.window || ({} as Window);
    window.secrets = {
      list: async () => [],
      saveKey: async () => true,
      getKey: async () => null,
      deleteKey: async () => true,
    };

    render(<SettingsPageContent />);

    // Verify desktop-specific section renders
    expect(
      screen.getByRole('heading', { name: 'Desktop Preferences', level: 2 })
    ).toBeInTheDocument();
    // New LLM keys settings section
    expect(screen.getByText('LLM Provider Keys')).toBeInTheDocument();
    expect(screen.getByLabelText('Provider')).toBeInTheDocument();
    expect(screen.getByLabelText('API Key')).toBeInTheDocument();
    expect(await screen.findByText('Saved Providers')).toBeInTheDocument();
  });
});
