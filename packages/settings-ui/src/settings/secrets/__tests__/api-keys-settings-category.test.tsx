import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createApiKeysSettingsCategory } from '../api-keys-settings-category';

vi.mock('../api-keys-settings', () => ({
  ApiKeysSettings: ({ statusError }: { readonly statusError?: string }) => (
    <div data-testid="api-keys-settings">{statusError}</div>
  ),
}));

describe('createApiKeysSettingsCategory', () => {
  it('returns the stable API-key category metadata', () => {
    const category = createApiKeysSettingsCategory();

    expect(category).toMatchObject({
      description: 'Manage API keys for external LLM providers.',
      id: 'api-keys',
      keywords: ['api', 'keys', 'secrets', 'credentials', 'openai', 'anthropic', 'google'],
      title: 'API Keys',
    });
    expect(category.icon).toBeDefined();
  });

  it('forwards status props to the API-key settings section', () => {
    const category = createApiKeysSettingsCategory({ statusError: 'Credential status failed.' });

    render(category.content);

    expect(screen.getByTestId('api-keys-settings')).toHaveTextContent('Credential status failed.');
  });
});
