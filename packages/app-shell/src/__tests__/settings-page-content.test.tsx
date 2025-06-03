import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SettingsPageContent } from '../settings-page-content';

// Mock the UI components
vi.mock('@brainstrike/ui', () => ({
  ThemeSettings: () => 'theme-settings-mock',
}));

describe('SettingsPageContent', () => {
  it('renders default sections and children', () => {
    render(
      <SettingsPageContent>
        <div data-testid="extra-section">Extra</div>
      </SettingsPageContent>
    );

    expect(screen.getByRole('heading', { name: 'Settings', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Appearance', level: 2 })).toBeInTheDocument();
    expect(screen.getByText('theme-settings-mock')).toBeInTheDocument();
    expect(screen.getByTestId('extra-section')).toBeInTheDocument();
  });
});
