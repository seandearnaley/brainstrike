import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogSectionProps } from '../catalog-section';
import type { CatalogToolbarProps } from '../catalog-toolbar';
import { ModelCatalog, type ModelCatalogProps } from '../model-catalog';
import { installCatalogDomStubs } from './catalog-dom-harness';
import { makeDbModel, makeDbProvider } from './catalog-test-harness';

vi.mock('@tanstack/react-virtual', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-virtual')>('@tanstack/react-virtual');
  const { createMockCatalogVirtualizer } =
    await vi.importActual<typeof import('./catalog-dom-harness')>('./catalog-dom-harness');
  return { ...actual, useVirtualizer: createMockCatalogVirtualizer };
});

// Pass-through spies: the real components render; the props each render
// received are recorded so identity contracts can be asserted.
const recorded = vi.hoisted(() => ({
  sections: [] as CatalogSectionProps[],
  toolbars: [] as CatalogToolbarProps[],
}));

vi.mock('../catalog-toolbar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../catalog-toolbar')>();
  return {
    ...actual,
    CatalogToolbar: (props: CatalogToolbarProps) => {
      recorded.toolbars.push(props);
      return <actual.CatalogToolbar {...props} />;
    },
  };
});

vi.mock('../catalog-section', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../catalog-section')>();
  return {
    ...actual,
    CatalogSection: (props: CatalogSectionProps) => {
      recorded.sections.push(props);
      return <actual.CatalogSection {...props} />;
    },
  };
});

const PROVIDERS = [
  makeDbProvider('openai', 'OpenAI', 0),
  makeDbProvider('anthropic', 'Anthropic', 1),
  makeDbProvider('openrouter', 'OpenRouter', 2),
];

// Real registry ids, so the projection joins real facts.
const MODELS = [
  makeDbModel({
    id: 'gpt-5.6-terra',
    isEnabled: true,
    name: 'GPT-5.6 Terra',
    providerId: 'openai',
    sortOrder: 0,
  }),
  makeDbModel({
    capabilities: { defaultDimension: 1536, type: 'embedding' },
    id: 'text-embedding-3-small',
    name: 'text-embedding-3-small',
    providerId: 'openai',
    sortOrder: 1,
  }),
  makeDbModel({
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    providerId: 'anthropic',
    sortOrder: 2,
  }),
  makeDbModel({
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    providerId: 'anthropic',
    sortOrder: 3,
  }),
  makeDbModel({
    id: 'openai/gpt-6-astra',
    name: 'GPT-6 Astra',
    providerId: 'openrouter',
    sortOrder: 4,
  }),
];

function catalogProps(overrides: Partial<ModelCatalogProps> = {}): ModelCatalogProps {
  return {
    busyModelIds: new Set<string>(),
    downloadedModels: {},
    downloadProgress: {},
    isDownloading: {},
    loaded: true,
    modelCacheDir: null,
    models: MODELS,
    onBulkChange: vi.fn(),
    onDownload: vi.fn(),
    onRefresh: vi.fn(),
    onToggle: vi.fn(),
    providers: PROVIDERS,
    ...overrides,
  };
}

function withEnabled(modelId: string, enabled: boolean): ModelCatalogProps['models'] {
  return MODELS.map((model) => (model.id === modelId ? { ...model, isEnabled: enabled } : model));
}

function sectionToggle(providerId: string): HTMLElement {
  return screen.getByTestId(`model-catalog-section-toggle-${providerId}`);
}

function search(): HTMLElement {
  return screen.getByRole('searchbox', { name: 'Search models' });
}

function lastToolbarProps(): CatalogToolbarProps {
  const props = recorded.toolbars.at(-1);
  if (!props) {
    throw new Error('CatalogToolbar never rendered');
  }
  return props;
}

function lastSectionProps(providerId: string): CatalogSectionProps {
  const props = recorded.sections.findLast((entry) => entry.section.providerId === providerId);
  if (!props) {
    throw new Error(`CatalogSection ${providerId} never rendered`);
  }
  return props;
}

beforeEach(() => {
  installCatalogDomStubs({ width: null });
  recorded.sections.length = 0;
  recorded.toolbars.length = 0;
});

afterEach(() => {
  installCatalogDomStubs({ width: null });
});

describe('ModelCatalog default view', () => {
  it('expands providers with an enabled model and collapses the rest', () => {
    render(<ModelCatalog {...catalogProps()} />);
    expect(sectionToggle('openai')).toHaveAttribute('aria-expanded', 'true');
    expect(sectionToggle('anthropic')).toHaveAttribute('aria-expanded', 'false');
    expect(sectionToggle('openrouter')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('model-row-gpt-5.6-terra')).toBeInTheDocument();
    expect(screen.queryByTestId('model-row-claude-opus-5')).not.toBeInTheDocument();
    expect(screen.getByTestId('model-catalog-summary')).toHaveTextContent(
      '5 models · 3 providers · 1 enabled'
    );
  });

  it('expands the first provider when nothing is enabled anywhere', () => {
    render(
      <ModelCatalog
        {...catalogProps({ models: MODELS.map((model) => ({ ...model, isEnabled: false })) })}
      />
    );
    expect(sectionToggle('openai')).toHaveAttribute('aria-expanded', 'true');
    expect(sectionToggle('anthropic')).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps Type at All and tags embedding rows, until Chat is chosen', async () => {
    render(<ModelCatalog {...catalogProps()} />);
    expect(
      within(screen.getByTestId('model-row-text-embedding-3-small')).getByText('Embedding')
    ).toBeInTheDocument();
    await userEvent.click(
      within(screen.getByRole('radiogroup', { name: 'Type' })).getByRole('radio', { name: 'Chat' })
    );
    await waitFor(() => {
      expect(screen.queryByTestId('model-row-text-embedding-3-small')).not.toBeInTheDocument();
    });
  });

  it('keeps row order stable when a model is toggled', async () => {
    const props = catalogProps();
    const { rerender } = render(<ModelCatalog {...props} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Enable text-embedding-3-small' }));
    expect(props.onToggle).toHaveBeenCalledWith('text-embedding-3-small', true);
    rerender(<ModelCatalog {...props} models={withEnabled('text-embedding-3-small', true)} />);
    const openai = screen.getByTestId('model-catalog-section-openai');
    expect(
      Array.from(openai.querySelectorAll('[data-testid^="model-row-"]'), (element) =>
        element.getAttribute('data-testid')
      )
    ).toEqual(['model-row-gpt-5.6-terra', 'model-row-text-embedding-3-small']);
  });

  it('opens a details row from the row disclosure', async () => {
    render(<ModelCatalog {...catalogProps()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show details for GPT-5.6 Terra' }));
    expect(await screen.findByTestId('model-details-gpt-5.6-terra')).toBeInTheDocument();
  });

  it('sorts rows within a section from the column header', async () => {
    render(<ModelCatalog {...catalogProps()} />);
    await userEvent.click(screen.getByTestId('model-catalog-expand-all'));
    await userEvent.click(screen.getByRole('button', { name: 'Context: sort ascending' }));
    const anthropic = screen.getByTestId('model-catalog-section-anthropic');
    expect(
      Array.from(anthropic.querySelectorAll('[data-testid^="model-row-"]'), (element) =>
        element.getAttribute('data-testid')
      )
    ).toEqual(['model-row-claude-sonnet-4-6', 'model-row-claude-opus-5']);
  });

  it('renders every expanded section inside the one catalog scroller', async () => {
    render(<ModelCatalog {...catalogProps()} />);
    await userEvent.click(screen.getByTestId('model-catalog-expand-all'));
    const scroller = screen.getByTestId('model-catalog-scroll');
    for (const providerId of ['openai', 'anthropic', 'openrouter']) {
      expect(scroller).toContainElement(screen.getByTestId(`model-catalog-section-${providerId}`));
      expect(lastSectionProps(providerId).scrollParentRef.current).toBe(scroller);
    }
    // The column header sits above the scroller, never inside it.
    expect(scroller).not.toContainElement(screen.getByTestId('model-catalog-column-header'));
  });
});

describe('ModelCatalog identity contracts', () => {
  it('keeps every untouched row object when one model is toggled (one projector per instance)', () => {
    const props = catalogProps();
    const { rerender } = render(<ModelCatalog {...props} />);
    const before = lastSectionProps('openai').section.rows;
    rerender(<ModelCatalog {...props} models={withEnabled('text-embedding-3-small', true)} />);
    const after = lastSectionProps('openai').section.rows;
    expect(after).not.toBe(before);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
  });

  it('keeps Expand all / Collapse all identity-stable while the visible sections are unchanged', () => {
    const props = catalogProps();
    const { rerender } = render(<ModelCatalog {...props} />);
    const { onCollapseAll, onExpandAll } = lastToolbarProps();
    rerender(<ModelCatalog {...props} models={withEnabled('text-embedding-3-small', true)} />);
    expect(lastToolbarProps().onExpandAll).toBe(onExpandAll);
    expect(lastToolbarProps().onCollapseAll).toBe(onCollapseAll);
  });
});

describe('ModelCatalog filtering', () => {
  it('expands every matching section, hides the rest, and restores the manual set on clear', async () => {
    render(<ModelCatalog {...catalogProps()} />);
    await userEvent.type(search(), 'claude');
    expect(await screen.findByTestId('model-row-claude-opus-5')).toBeInTheDocument();
    expect(screen.queryByTestId('model-catalog-section-openai')).not.toBeInTheDocument();
    expect(screen.getByTestId('model-catalog-summary')).toHaveTextContent(
      '2 of 5 models match · 1 provider'
    );
    await userEvent.click(screen.getByTestId('model-catalog-clear-filters'));
    await waitFor(() => {
      expect(sectionToggle('anthropic')).toHaveAttribute('aria-expanded', 'false');
    });
    expect(sectionToggle('openai')).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps a section the user collapsed during a filter session collapsed until filters clear', async () => {
    render(<ModelCatalog {...catalogProps()} />);
    await userEvent.type(search(), 'claude');
    await screen.findByTestId('model-row-claude-opus-5');
    await userEvent.click(sectionToggle('anthropic'));
    expect(sectionToggle('anthropic')).toHaveAttribute('aria-expanded', 'false');
    await userEvent.type(search(), ' sonnet');
    await waitFor(() => {
      expect(screen.getByTestId('model-catalog-summary')).toHaveTextContent('1 of 5 models match');
    });
    expect(sectionToggle('anthropic')).toHaveAttribute('aria-expanded', 'false');
  });

  it('bulk-enables only the shown rows that would change', async () => {
    const props = catalogProps({ models: withEnabled('claude-sonnet-4-6', true) });
    render(<ModelCatalog {...props} />);
    await userEvent.type(search(), 'claude');
    await userEvent.click(await screen.findByRole('button', { name: 'Enable 2 shown' }));
    expect(props.onBulkChange).toHaveBeenCalledWith({
      enabled: true,
      modelIds: ['claude-opus-5'],
      scopeLabel: 'Anthropic',
    });
  });

  it('bulk-disables only the rows that are enabled, never re-writing unchanged rows', async () => {
    const props = catalogProps({ models: withEnabled('claude-sonnet-4-6', true) });
    render(<ModelCatalog {...props} />);
    await userEvent.click(sectionToggle('anthropic'));
    await userEvent.click(screen.getByTestId('model-catalog-disable-anthropic'));
    expect(props.onBulkChange).toHaveBeenCalledTimes(1);
    expect(props.onBulkChange).toHaveBeenCalledWith({
      enabled: false,
      modelIds: ['claude-sonnet-4-6'],
      scopeLabel: 'Anthropic',
    });
  });

  it('never lets a bulk action reach a row the filter hides', async () => {
    const props = catalogProps({ models: withEnabled('claude-sonnet-4-6', true) });
    render(<ModelCatalog {...props} />);
    await userEvent.type(search(), 'opus');
    // Sonnet is enabled but hidden by the search, so "Disable 1 shown" has nothing to do.
    expect(await screen.findByRole('button', { name: 'Disable 1 shown' })).toBeDisabled();
  });

  it('shows No models match with a working Clear filters action', async () => {
    render(<ModelCatalog {...catalogProps()} />);
    await userEvent.type(search(), 'zzzz');
    const empty = await screen.findByTestId('model-catalog-no-matches');
    expect(within(empty).getByText('No models match')).toBeInTheDocument();
    await userEvent.click(within(empty).getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByTestId('model-row-gpt-5.6-terra')).toBeInTheDocument();
  });

  it('drops a provider selection once that provider leaves the catalog', async () => {
    const props = catalogProps();
    const { rerender } = render(<ModelCatalog {...props} />);
    await userEvent.click(screen.getByTestId('model-catalog-providers-trigger'));
    await userEvent.click(await screen.findByRole('checkbox', { name: /Anthropic/ }));
    expect(await screen.findByRole('button', { name: 'Remove filter Anthropic' })).toBeVisible();
    expect(screen.queryByTestId('model-catalog-section-openai')).not.toBeInTheDocument();

    rerender(
      <ModelCatalog
        {...props}
        models={MODELS.filter((model) => model.providerId !== 'anthropic')}
      />
    );

    expect(
      screen.queryByRole('button', { name: 'Remove filter Anthropic' })
    ).not.toBeInTheDocument();
    expect(lastToolbarProps().filters.providerIds.size).toBe(0);
    expect(screen.getByTestId('model-catalog-summary')).toHaveTextContent(
      '3 models · 2 providers · 1 enabled'
    );
    expect(screen.getByTestId('model-catalog-section-openai')).toBeInTheDocument();
  });
});

describe('ModelCatalog states', () => {
  it('shows the empty catalog state with Refresh once loaded', async () => {
    const props = catalogProps({ models: [] });
    render(<ModelCatalog {...props} />);
    const empty = screen.getByTestId('model-catalog-empty');
    expect(within(empty).getByText('No models are catalogued yet')).toBeInTheDocument();
    await userEvent.click(within(empty).getByRole('button', { name: 'Refresh' }));
    expect(props.onRefresh).toHaveBeenCalledTimes(1);
  });

  it('shows a loading status before the first load', () => {
    render(<ModelCatalog {...catalogProps({ loaded: false, models: [] })} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading models…');
  });

  it('switches to the compact layout when the catalog is narrower than 640px', async () => {
    installCatalogDomStubs({ width: 500 });
    render(<ModelCatalog {...catalogProps()} />);
    await waitFor(() => {
      expect(screen.getByTestId('model-catalog')).toHaveAttribute('data-width-tier', 'narrow');
    });
    expect(screen.getByTestId('model-catalog-filters-trigger')).toBeInTheDocument();
    expect(screen.queryByText(/per million tokens/)).not.toBeInTheDocument();
  });

  it('shows the tagline until the catalog is narrow', async () => {
    const models = MODELS.map((model) =>
      model.id === 'gpt-5.6-terra' ? { ...model, tagline: 'Flagship terra model' } : model
    );
    const wide = render(<ModelCatalog {...catalogProps({ models })} />);
    expect(screen.getByTestId('model-catalog')).toHaveAttribute('data-width-tier', 'wide');
    expect(
      within(screen.getByTestId('model-row-gpt-5.6-terra')).getByText('Flagship terra model')
    ).toBeInTheDocument();
    wide.unmount();

    installCatalogDomStubs({ width: 500 });
    render(<ModelCatalog {...catalogProps({ models })} />);
    await waitFor(() => {
      expect(screen.getByTestId('model-catalog')).toHaveAttribute('data-width-tier', 'narrow');
    });
    expect(screen.queryByText('Flagship terra model')).not.toBeInTheDocument();
  });
});

describe('ModelCatalog / shortcut', () => {
  it('focuses search on / from a non-editable target, without typing the slash', () => {
    render(<ModelCatalog {...catalogProps()} />);
    expect(fireEvent.keyDown(document.body, { key: '/' })).toBe(false);
    expect(search()).toHaveFocus();
    expect(search()).toHaveValue('');
  });

  it('leaves / alone while typing in another field', () => {
    render(
      <>
        <input aria-label="Other field" />
        <ModelCatalog {...catalogProps()} />
      </>
    );
    const other = screen.getByRole('textbox', { name: 'Other field' });
    other.focus();
    expect(fireEvent.keyDown(other, { key: '/' })).toBe(true);
    expect(other).toHaveFocus();
  });

  it('leaves / alone inside a contenteditable region', () => {
    render(
      <>
        <div contentEditable data-testid="notes" suppressContentEditableWarning>
          <span>draft</span>
        </div>
        <ModelCatalog {...catalogProps()} />
      </>
    );
    // The handler reads the event target, so a keydown dispatched from inside
    // the editable region is what matters.
    const inside = within(screen.getByTestId('notes')).getByText('draft');
    expect(fireEvent.keyDown(inside, { key: '/' })).toBe(true);
    expect(search()).not.toHaveFocus();
  });

  it('ignores / while the settings route is hidden (keep-mounted tab)', () => {
    render(
      <div aria-hidden="true">
        <ModelCatalog {...catalogProps()} />
      </div>
    );
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(document.body);
  });
});

// Ported from the deleted model-list.test.tsx (BST-1805 spec §10 step 3). Its
// Chat/Embeddings tab and Local/Remote toggle assertions were dropped: those
// controls no longer exist (the Type segment replaces the tabs; see
// "keeps Type at All …" above).
describe('ModelCatalog behaviour ported from ModelList', () => {
  const LOCAL_PROVIDERS = [
    makeDbProvider('transformers', 'Transformers', 0),
    makeDbProvider('openai', 'OpenAI', 1),
  ];
  const LOCAL_MODELS = [
    makeDbModel({
      capabilities: { defaultDimension: 384, type: 'embedding' },
      id: 'local-ready',
      isEnabled: true,
      name: 'Local Ready',
      providerId: 'transformers',
      sortOrder: 0,
    }),
    makeDbModel({
      capabilities: { defaultDimension: 384, type: 'embedding' },
      id: 'local-downloading',
      name: 'Local Downloading',
      providerId: 'transformers',
      sortOrder: 1,
    }),
    makeDbModel({
      capabilities: { defaultDimension: 384, type: 'embedding' },
      id: 'transformers-stream',
      name: 'HF Stream Model',
      providerId: 'transformers',
      sortOrder: 2,
    }),
    makeDbModel({ id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', providerId: 'openai', sortOrder: 3 }),
    makeDbModel({
      id: 'mystery-model',
      name: 'Mystery Model',
      providerId: 'missing-provider',
      sortOrder: 4,
    }),
  ];

  function localProps(overrides: Partial<ModelCatalogProps> = {}): ModelCatalogProps {
    return catalogProps({
      downloadedModels: { 'transformers-stream': true },
      downloadProgress: { 'local-downloading': 25 },
      isDownloading: { 'local-downloading': true },
      modelCacheDir: '/models',
      models: LOCAL_MODELS,
      providers: LOCAL_PROVIDERS,
      ...overrides,
    });
  }

  it('keeps a model whose provider row is missing visible under Unknown provider', async () => {
    render(<ModelCatalog {...localProps()} />);
    const unknown = screen.getByTestId('model-catalog-section-__unknown-provider__');
    expect(within(unknown).getByText('Unknown provider')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('model-catalog-expand-all'));
    expect(within(unknown).getByTestId('model-row-mystery-model')).toBeInTheDocument();
  });

  it('filters rows by search and keeps the settings search-field layout', async () => {
    render(<ModelCatalog {...localProps()} />);
    expect(search().style.paddingLeft).toBe('2.5rem');
    expect(
      search().parentElement?.querySelector<HTMLElement>('[data-slot="settings-search-icon"]')
        ?.style.left
    ).toBe('0.75rem');
    await userEvent.type(search(), 'terra');
    expect(await screen.findByTestId('model-row-gpt-5.6-terra')).toBeInTheDocument();
    expect(screen.queryByTestId('model-row-local-ready')).not.toBeInTheDocument();
  });

  it('renders download progress, the downloaded state with its cache path, and Download', async () => {
    const props = localProps();
    render(<ModelCatalog {...props} />);
    await userEvent.click(screen.getByTestId('model-catalog-expand-all'));

    const downloadingRow = screen.getByTestId('model-row-local-downloading').closest('tr');
    expect(downloadingRow).not.toBeNull();
    expect(within(downloadingRow as HTMLElement).getByText('25%')).toBeInTheDocument();

    expect(screen.getByRole('img', { name: 'HF Stream Model downloaded' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show details for HF Stream Model' }));
    expect(
      within(await screen.findByTestId('model-details-transformers-stream')).getByText(
        '/models/transformers-stream'
      )
    ).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('model-download-local-ready'));
    expect(props.onDownload).toHaveBeenCalledWith('local-ready');
    // A hosted provider's rows never offer a download.
    expect(screen.queryByTestId('model-download-gpt-5.6-terra')).not.toBeInTheDocument();
  });

  it('toggles a model on and an enabled model off', async () => {
    const props = localProps();
    render(<ModelCatalog {...props} />);
    await userEvent.click(screen.getByTestId('model-catalog-expand-all'));
    await userEvent.click(screen.getByTestId('model-toggle-gpt-5.6-terra'));
    expect(props.onToggle).toHaveBeenCalledWith('gpt-5.6-terra', true);
    await userEvent.click(screen.getByTestId('model-toggle-local-ready'));
    expect(props.onToggle).toHaveBeenCalledWith('local-ready', false);
  });

  it('disables a model switch while its write is in flight', async () => {
    const props = localProps({ busyModelIds: new Set(['gpt-5.6-terra']) });
    render(<ModelCatalog {...props} />);
    await userEvent.click(screen.getByTestId('model-catalog-expand-all'));
    const busySwitch = screen.getByTestId('model-toggle-gpt-5.6-terra');
    expect(busySwitch).toBeDisabled();
    expect(busySwitch).toHaveAttribute('aria-busy', 'true');
    expect(props.onToggle).not.toHaveBeenCalled();
  });
});
