/**
 * BST-1805: the subagent budgets live in the Subagents category beside the
 * personas. Settings search matches categories (title, description, keywords),
 * so a budget search must land on that category.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSubagentPersonasSettingsCategory } from '../settings-category-factories';
import { SettingsPageContent } from '../settings-page-content';

vi.mock('../settings/models/subagent-settings-section', () => ({
  SubagentSettingsSection: () => <div data-testid="subagent-settings-section-mock" />,
}));

vi.mock('../settings/system/subagent-personas-settings-section', () => ({
  SubagentPersonasSettingsSection: () => <div data-testid="subagent-personas-section-mock" />,
}));

beforeEach(() => {
  window.location.hash = '';
});
afterEach(() => {
  cleanup();
});

describe('createSubagentPersonasSettingsCategory', () => {
  it('renders the subagent budgets below the personas', () => {
    render(createSubagentPersonasSettingsCategory().content);

    const personas = screen.getByTestId('subagent-personas-section-mock');
    const budgets = screen.getByTestId('subagent-settings-section-mock');
    expect(personas.compareDocumentPosition(budgets) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });
});

describe('settings search for the relocated sections', () => {
  const renderSettings = () =>
    render(
      <SettingsPageContent
        categories={[
          {
            content: <div data-testid="model-catalog-mock" />,
            description: 'Browse every catalogued model and enable the ones you want.',
            id: 'models',
            keywords: ['models', 'catalog', 'llm'],
            title: 'Model Catalog',
          },
          createSubagentPersonasSettingsCategory(),
        ]}
        defaultCategoryId="models"
      />
    );

  const search = (value: string) =>
    fireEvent.change(screen.getByRole('searchbox', { name: /search settings/iu }), {
      target: { value },
    });

  const navButtonNames = (): string[] =>
    within(screen.getByRole('navigation', { name: /settings categories/iu }))
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-label') !== 'Clear search')
      .map((button) => button.textContent ?? '');

  it.each(['budgets', 'output tokens', 'steps'])('lands a "%s" search on Subagents', (query) => {
    renderSettings();
    search(query);

    expect(navButtonNames()).toEqual(['Subagents']);
    const pane = screen.getByTestId('settings-category-subagents');
    expect(within(pane).getByTestId('subagent-settings-section-mock')).toBeInTheDocument();
  });
});
