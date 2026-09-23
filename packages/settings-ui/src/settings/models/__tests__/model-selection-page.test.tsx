/**
 * BST-1805: the Model Catalog page is about models. Assistant Memory and the
 * subagent budgets moved to their own settings categories, so the page must
 * not render them; the cache directory control and the catalog list stay.
 */

import '@testing-library/jest-dom/vitest';
import { __resetModelRegistryStoreForTests } from '@brainstrike/app-state/stores/model-registry-store';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelSelectionPage } from '../model-selection-page';

vi.mock('@brainstrike/db/react', () => ({
  usePGliteDatabase: vi.fn(() => null),
}));

vi.mock('@brainstrike/app-state/hooks/use-model-registry', () => ({
  useEnsureModelRegistry: vi.fn(),
}));

vi.mock('../use-model-toggle', () => ({
  useModelToggle: () => ({ busyModelIds: new Set<string>(), toggle: vi.fn() }),
}));

vi.mock('../model-list', () => ({
  ModelList: () => <div data-testid="model-list-mock" />,
}));

vi.mock('../assistant-memory-settings-section', () => ({
  AssistantMemorySettingsSection: () => (
    <div data-testid="assistant-memory-settings-section-mock" />
  ),
}));

vi.mock('../subagent-settings-section', () => ({
  SubagentSettingsSection: () => <div data-testid="subagent-settings-section-mock" />,
}));

beforeEach(() => {
  __resetModelRegistryStoreForTests();
});
afterEach(() => {
  cleanup();
});

describe('ModelSelectionPage', () => {
  it('renders the cache directory control and the catalog, and no memory or subagent settings', () => {
    render(<ModelSelectionPage />);

    expect(screen.getByTestId('model-cache-dir-input')).toBeInTheDocument();
    expect(screen.getByTestId('model-registry-refresh')).toBeInTheDocument();
    expect(screen.getByTestId('model-list-mock')).toBeInTheDocument();
    expect(screen.queryByTestId('assistant-memory-settings-section-mock')).not.toBeInTheDocument();
    expect(screen.queryByTestId('subagent-settings-section-mock')).not.toBeInTheDocument();
  });
});
