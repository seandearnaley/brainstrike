import { render, screen } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { describe, expect, it } from 'vitest';
import SettingsPageContent from '../../../../renderer/components/settings/page-content';

describe('SettingsPageContent', () => {
  it('renders headings and explanatory text', () => {
    render(
      <HelmetProvider>
        <SettingsPageContent />
      </HelmetProvider>
    );

    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Desktop Preferences' })).toBeInTheDocument();
    expect(
      screen.getByText('Desktop-specific settings will be implemented here.')
    ).toBeInTheDocument();
  });
});
