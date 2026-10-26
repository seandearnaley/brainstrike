/**
 * BST-1805: the Model Catalog page is about models. Assistant Memory and the
 * subagent budgets moved to their own settings categories, so the page must
 * not render them. The registry refresh lives in the category header
 * (`ModelCatalogHeaderActions`); the body is the catalog.
 */

import '@testing-library/jest-dom/vitest';
import { useModelRegistrySource } from '@brainstrike/app-state/hooks/use-model-registry';
import {
  __resetModelRegistryStoreForTests,
  useModelRegistryStore,
} from '@brainstrike/app-state/stores/model-registry-store';
import { act } from '@brainstrike/test-utils/react-act';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelCatalogProps } from '../model-catalog';
import { ModelCatalogHeaderActions, ModelSelectionPage } from '../model-selection-page';
import { installCatalogDomStubs } from './catalog-dom-harness';

const catalogProps = vi.hoisted(() => ({ current: null as ModelCatalogProps | null }));
const toggleMany = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());

vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  useToast: () => ({ toast }),
}));

const DATABASE_NOT_READY_TOAST = {
  description: 'The model database is not ready yet. Try again in a moment.',
  title: 'Could not refresh the model registry',
  variant: 'destructive',
};

vi.mock('@brainstrike/app-state/hooks/use-model-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/app-state/hooks/use-model-registry')>()),
  useEnsureModelRegistry: vi.fn(),
  useModelRegistrySource: vi.fn(() => null),
}));

vi.mock('../use-model-toggle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../use-model-toggle')>()),
  useModelToggle: () => ({ busyModelIds: new Set<string>(), toggle: vi.fn(), toggleMany }),
}));

vi.mock('../model-catalog', () => ({
  ModelCatalog: (props: ModelCatalogProps) => {
    catalogProps.current = props;
    return <div data-testid="model-catalog-mock" />;
  },
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
  installCatalogDomStubs({ width: null });
  __resetModelRegistryStoreForTests();
  catalogProps.current = null;
  vi.mocked(useModelRegistrySource).mockReturnValue(null);
  toggleMany.mockReset();
  toast.mockReset();
  toggleMany.mockResolvedValue({ committed: false });
});
afterEach(() => {
  cleanup();
});

describe('ModelSelectionPage', () => {
  it('renders the catalog, and no memory or subagent settings', () => {
    render(<ModelSelectionPage />);

    expect(screen.getByTestId('model-catalog-mock')).toBeInTheDocument();
    expect(catalogProps.current?.loaded).toBe(false);
    expect(screen.queryByTestId('model-registry-refresh')).not.toBeInTheDocument();
    expect(screen.queryByTestId('assistant-memory-settings-section-mock')).not.toBeInTheDocument();
    expect(screen.queryByTestId('subagent-settings-section-mock')).not.toBeInTheDocument();
  });

  it('routes a bulk change through the one-write toggleMany path', () => {
    render(<ModelSelectionPage />);
    act(() => {
      catalogProps.current?.onBulkChange({
        enabled: false,
        modelIds: ['a', 'b'],
        scopeLabel: 'OpenAI',
      });
    });
    expect(toggleMany).toHaveBeenCalledWith(['a', 'b'], false);
  });

  it('retries the registry fetch against the database', () => {
    const db = { query: vi.fn() };
    vi.mocked(useModelRegistrySource).mockReturnValue(db as never);
    const fetchRegistry = vi.fn().mockResolvedValue(undefined);
    act(() => {
      useModelRegistryStore.setState({ error: 'boom', fetchRegistry });
    });
    render(<ModelSelectionPage />);
    fireEvent.click(screen.getByTestId('model-registry-retry'));
    expect(fetchRegistry).toHaveBeenCalledWith(db);
  });

  it('Retry with no database raises the not-ready toast instead of doing nothing', () => {
    const fetchRegistry = vi.fn().mockResolvedValue(undefined);
    act(() => {
      useModelRegistryStore.setState({ error: 'boom', fetchRegistry });
    });
    render(<ModelSelectionPage />);
    fireEvent.click(screen.getByTestId('model-registry-retry'));
    expect(fetchRegistry).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(DATABASE_NOT_READY_TOAST);
  });

  it('onRefresh with no database raises the not-ready toast instead of doing nothing', () => {
    const fetchRegistry = vi.fn().mockResolvedValue(undefined);
    act(() => {
      useModelRegistryStore.setState({ fetchRegistry });
    });
    render(<ModelSelectionPage />);
    act(() => {
      catalogProps.current?.onRefresh();
    });
    expect(fetchRegistry).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(DATABASE_NOT_READY_TOAST);
  });

  it('shows the registry error with Retry instead of the catalog', () => {
    act(() => {
      useModelRegistryStore.setState({ error: 'boom' });
    });
    render(<ModelSelectionPage />);

    expect(screen.getByTestId('model-registry-error')).toHaveTextContent('boom');
    expect(screen.getByTestId('model-registry-retry')).toBeInTheDocument();
    expect(screen.queryByTestId('model-catalog-mock')).not.toBeInTheDocument();
  });
});

describe('ModelCatalogHeaderActions', () => {
  it('holds the registry refresh', () => {
    render(<ModelCatalogHeaderActions />);

    const refresh = screen.getByTestId('model-registry-refresh');
    expect(refresh).toHaveAccessibleName('Refresh model registry');
    expect(refresh).toBeEnabled();

    act(() => {
      useModelRegistryStore.setState({ isLoading: true });
    });
    expect(screen.getByTestId('model-registry-refresh')).toBeDisabled();
  });

  it('Refresh with no database raises the not-ready toast instead of doing nothing', () => {
    const fetchRegistry = vi.fn().mockResolvedValue(undefined);
    act(() => {
      useModelRegistryStore.setState({ fetchRegistry });
    });
    render(<ModelCatalogHeaderActions />);
    fireEvent.click(screen.getByTestId('model-registry-refresh'));
    expect(fetchRegistry).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(DATABASE_NOT_READY_TOAST);
  });

  it('Refresh fetches the registry against the database', () => {
    const db = { query: vi.fn() };
    vi.mocked(useModelRegistrySource).mockReturnValue(db as never);
    const fetchRegistry = vi.fn().mockResolvedValue(undefined);
    act(() => {
      useModelRegistryStore.setState({ fetchRegistry });
    });
    render(<ModelCatalogHeaderActions />);
    fireEvent.click(screen.getByTestId('model-registry-refresh'));
    expect(fetchRegistry).toHaveBeenCalledWith(db);
    expect(toast).not.toHaveBeenCalled();
  });
});
