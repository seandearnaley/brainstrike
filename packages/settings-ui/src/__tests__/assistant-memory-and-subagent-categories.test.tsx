/**
 * BST-1805: Assistant Memory has its own settings category, and the subagent
 * budgets live in the Subagents category beside the personas. Settings search
 * matches categories (title, description, keywords), so a memory or budget
 * search must land on these categories.
 */

import '@testing-library/jest-dom/vitest';
import type { ProviderKeySource } from '@brainstrike/assistant-contract';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMemorySettingsSectionProps } from '../settings/models/assistant-memory-settings-section';
import {
  createAssistantMemorySettingsCategory,
  createSubagentPersonasSettingsCategory,
} from '../settings-category-factories';
import { SettingsPageContent } from '../settings-page-content';

const memorySectionProps = vi.hoisted(() => ({
  calls: [] as AssistantMemorySettingsSectionProps[],
}));

vi.mock('../settings/models/assistant-memory-settings-section', () => ({
  AssistantMemorySettingsSection: (props: AssistantMemorySettingsSectionProps) => {
    memorySectionProps.calls.push(props);
    return <div data-testid="assistant-memory-settings-section-mock" />;
  },
}));

vi.mock('../settings/models/subagent-settings-section', () => ({
  SubagentSettingsSection: () => <div data-testid="subagent-settings-section-mock" />,
}));

vi.mock('../settings/system/subagent-personas-settings-section', () => ({
  SubagentPersonasSettingsSection: () => <div data-testid="subagent-personas-section-mock" />,
}));

const OPENAI_ENV_SOURCE: ProviderKeySource<SupportedProvider> = {
  envVar: 'OPENAI_API_KEY',
  provider: 'openai',
  source: 'env',
};

beforeEach(() => {
  window.location.hash = '';
  memorySectionProps.calls = [];
});
afterEach(() => {
  cleanup();
});

describe('createAssistantMemorySettingsCategory', () => {
  it('registers the Assistant Memory category with its search keywords', () => {
    const category = createAssistantMemorySettingsCategory({
      assistantMemoryBackendAvailable: true,
    });

    expect(category.id).toBe('assistant-memory');
    expect(category.title).toBe('Assistant Memory');
    expect(category.keywords).toEqual([
      'memory',
      'observations',
      'semantic recall',
      'mastra',
      'embedding',
    ]);
  });

  it('renders the memory section with the backend flag and provider key sources', () => {
    const category = createAssistantMemorySettingsCategory({
      assistantMemoryBackendAvailable: true,
      providerKeySources: [OPENAI_ENV_SOURCE],
    });
    render(category.content);

    expect(screen.getByTestId('assistant-memory-settings-section-mock')).toBeInTheDocument();
    expect(memorySectionProps.calls.at(-1)).toEqual({
      assistantMemoryBackendAvailable: true,
      providerKeySources: [OPENAI_ENV_SOURCE],
    });
  });

  it('omits providerKeySources when none are supplied', () => {
    const category = createAssistantMemorySettingsCategory({
      assistantMemoryBackendAvailable: false,
    });
    render(category.content);

    expect(memorySectionProps.calls.at(-1)).toEqual({ assistantMemoryBackendAvailable: false });
  });
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
            keywords: ['models', 'catalog', 'llm', 'embedding', 'vector'],
            title: 'Model Catalog',
          },
          createAssistantMemorySettingsCategory({ assistantMemoryBackendAvailable: true }),
          createSubagentPersonasSettingsCategory(),
        ]}
        defaultCategoryId="models"
      />
    );

  const search = (value: string) =>
    fireEvent.change(screen.getByRole('searchbox', { name: /search settings/i }), {
      target: { value },
    });

  const navButtonNames = (): string[] =>
    within(screen.getByRole('navigation', { name: /settings categories/i }))
      .getAllByRole('button')
      .map((button) => button.textContent ?? '');

  it.each(['memory', 'semantic recall', 'observations'])(
    'lands a "%s" search on Assistant Memory',
    (query) => {
      renderSettings();
      search(query);

      expect(navButtonNames()).toEqual(['Assistant Memory']);
      const pane = screen.getByTestId('settings-category-assistant-memory');
      expect(
        within(pane).getByTestId('assistant-memory-settings-section-mock')
      ).toBeInTheDocument();
    }
  );

  it.each(['budgets', 'output tokens', 'steps'])('lands a "%s" search on Subagents', (query) => {
    renderSettings();
    search(query);

    expect(navButtonNames()).toEqual(['Subagents']);
    const pane = screen.getByTestId('settings-category-subagents');
    expect(within(pane).getByTestId('subagent-settings-section-mock')).toBeInTheDocument();
  });
});
