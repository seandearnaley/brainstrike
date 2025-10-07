import { ThemeProvider } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsPageContent from '../../../../renderer/components/settings/page-content';

type SecretsApi = {
  list: () => Promise<string[]>;
  saveKey: (provider: string, key: string) => Promise<unknown>;
  getKey: (provider: string) => Promise<string | null>;
  deleteKey: (provider: string) => Promise<boolean>;
};

const getWindowWithSecrets = () => window as typeof window & { secrets?: SecretsApi };

beforeEach(() => {
  const secrets: SecretsApi = {
    list: vi.fn().mockResolvedValue([]),
    saveKey: vi.fn().mockResolvedValue(true),
    getKey: vi.fn().mockResolvedValue(null),
    deleteKey: vi.fn().mockResolvedValue(true),
  };
  getWindowWithSecrets().secrets = secrets;
});

describe('SettingsPageContent (coverage)', () => {
  it('renders LLM credentials form fields', async () => {
    render(
      <ThemeProvider>
        <SettingsPageContent />
      </ThemeProvider>
    );

    // Switch to desktop preferences pane to expose the form
    const preferencesButton = await screen.findByRole('button', { name: /Desktop Preferences/i });
    preferencesButton.click();

    expect(await screen.findByLabelText('Provider')).toBeInTheDocument();
    expect(screen.getByLabelText('API Key')).toBeInTheDocument();
    expect(await screen.findByText('Saved Providers')).toBeInTheDocument();
  });
});
