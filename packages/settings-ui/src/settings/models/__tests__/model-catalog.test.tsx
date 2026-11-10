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
    id: 'gpt-5.6-mini',
    name: 'gpt-5.6-mini',
    providerId: 'openai',
    sortOrder: 1,
  }),
  makeDbModel({
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    providerId: 'anthropic',
    sortOrder: 2,
  }),
  makeDbModel({
    id: 'claude-haiku-5-5',
    name: 'Claude Haiku 5.5',
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
    loaded: true,
    models: MODELS,
    onBulkChange: vi.fn(),
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
    expect(screen.queryByTestId('model-row-claude-opus-5-5')).not.toBeInTheDocument();
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

  it('keeps row order stable when a model is toggled', async () => {
    const props = catalogProps();
    const { rerender } = render(<ModelCatalog {...props} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Enable gpt-5.6-mini' }));
    expect(props.onToggle).toHaveBeenCalledWith('gpt-5.6-mini', true);
    rerender(<ModelCatalog {...props} models={withEnabled('gpt-5.6-mini', true)} />);
    const openai = screen.getByTestId('model-catalog-section-openai');
    expect(
      Array.from(openai.querySelectorAll('[data-testid^="model-row-"]'), (element) =>
        element.getAttribute('data-testid')
      )
    ).toEqual(['model-row-gpt-5.6-terra', 'model-row-gpt-5.6-mini']);
  });

  it('opens a details row from the row disclosure', async () => {
    render(<ModelCatalog {...catalogProps()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show details for GPT-5.6 Terra' }));
    expect(await screen.findByTestId('model-details-gpt-5.6-terra')).toBeInTheDocument();
  });

  it('sorts rows within a section from the column header', async () => {
    render(<ModelCatalog {...catalogProps()} />);
    await userEvent.click(screen.getByTestId('model-catalog-expand-all'));
    await userEvent.click(screen.getByRole('button', { name: 'Input price: sort ascending' }));
    const anthropic = screen.getByTestId('model-catalog-section-anthropic');
    expect(
      Array.from(anthropic.querySelectorAll('[data-testid^="model-row-"]'), (element) =>
        element.getAttribute('data-testid')
      )
    ).toEqual(['model-row-claude-haiku-5-5', 'model-row-claude-opus-5-5']);
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
    rerender(<ModelCatalog {...props} models={withEnabled('gpt-5.6-mini', true)} />);
    const after = lastSectionProps('openai').section.rows;
    expect(after).not.toBe(before);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
  });

  it('keeps Expand all / Collapse all identity-stable while the visible sections are unchanged', () => {
    const props = catalogProps();
    const { rerender } = render(<ModelCatalog {...props} />);
    const { onCollapseAll, onExpandAll } = lastToolbarProps();
    rerender(<ModelCatalog {...props} models={withEnabled('gpt-5.6-mini', true)} />);
    expect(lastToolbarProps().onExpandAll).toBe(onExpandAll);
    expect(lastToolbarProps().onCollapseAll).toBe(onCollapseAll);
  });
});

describe('ModelCatalog filtering', () => {
  it('expands every matching section, hides the rest, and restores the manual set on clear', async () => {
    render(<ModelCatalog {...catalogProps()} />);
    await userEvent.type(search(), 'claude');
    expect(await screen.findByTestId('model-row-claude-opus-5-5')).toBeInTheDocument();
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
    await screen.findByTestId('model-row-claude-opus-5-5');
    await userEvent.click(sectionToggle('anthropic'));
    expect(sectionToggle('anthropic')).toHaveAttribute('aria-expanded', 'false');
    await userEvent.type(search(), ' haiku');
    await waitFor(() => {
      expect(screen.getByTestId('model-catalog-summary')).toHaveTextContent('1 of 5 models match');
    });
    expect(sectionToggle('anthropic')).toHaveAttribute('aria-expanded', 'false');
  });

  it('bulk-enables only the shown rows that would change', async () => {
    const props = catalogProps({ models: withEnabled('claude-haiku-5-5', true) });
    render(<ModelCatalog {...props} />);
    await userEvent.type(search(), 'claude');
    await userEvent.click(await screen.findByRole('button', { name: 'Enable 2 shown' }));
    expect(props.onBulkChange).toHaveBeenCalledWith({
      enabled: true,
      modelIds: ['claude-opus-5-5'],
      scopeLabel: 'Anthropic',
    });
  });

  it('bulk-disables only the rows that are enabled, never re-writing unchanged rows', async () => {
    const props = catalogProps({ models: withEnabled('claude-haiku-5-5', true) });
    render(<ModelCatalog {...props} />);
    await userEvent.click(sectionToggle('anthropic'));
    await userEvent.click(screen.getByTestId('model-catalog-disable-anthropic'));
    expect(props.onBulkChange).toHaveBeenCalledTimes(1);
    expect(props.onBulkChange).toHaveBeenCalledWith({
      enabled: false,
      modelIds: ['claude-haiku-5-5'],
      scopeLabel: 'Anthropic',
    });
  });

  it('disables both bulk buttons while a shown row in the section is busy', async () => {
    const props = catalogProps({
      busyModelIds: new Set(['claude-haiku-5-5']),
      models: withEnabled('claude-haiku-5-5', true),
    });
    render(<ModelCatalog {...props} />);
    await userEvent.click(sectionToggle('anthropic'));
    expect(screen.getByTestId('model-catalog-enable-anthropic')).toBeDisabled();
    expect(screen.getByTestId('model-catalog-disable-anthropic')).toBeDisabled();
  });

  it('never lets a bulk action reach a row the filter hides', async () => {
    const props = catalogProps({ models: withEnabled('claude-haiku-5-5', true) });
    render(<ModelCatalog {...props} />);
    await userEvent.type(search(), 'opus');
    // Haiku is enabled but hidden by the search, so "Disable 1 shown" has nothing to do.
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
    await userEvent.click(await screen.findByRole('checkbox', { name: /Anthropic/u }));
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

describe('ModelCatalog archived models', () => {
  const ARCHIVED = [
    makeDbModel({
      id: 'claude-fable-5-2',
      name: 'Claude Fable 5.2',
      providerId: 'anthropic',
      sortOrder: 0,
    }),
    makeDbModel({
      id: 'claude-fable-5-1',
      isEnabled: true,
      name: 'Claude Fable 5.1',
      providerId: 'anthropic',
      sortOrder: 1,
    }),
    makeDbModel({
      id: 'claude-opus-5',
      name: 'Claude Opus 5',
      providerId: 'anthropic',
      sortOrder: 2,
    }),
    makeDbModel({
      id: 'gpt-5.4-nano',
      isEnabled: true,
      name: 'GPT-5.4 nano',
      providerId: 'openai',
      sortOrder: 3,
    }),
  ];

  it('hides an archived model until Show archived is on, unless the user enabled it', async () => {
    render(<ModelCatalog {...catalogProps({ models: ARCHIVED })} />);
    await userEvent.click(screen.getByTestId('model-catalog-expand-all'));
    expect(screen.getByTestId('model-catalog-section-archived-anthropic')).toHaveTextContent(
      '2 archived'
    );
    // Fable 5.1 is archived but enabled, so it stays listed with its badge.
    expect(screen.getByTestId('model-lifecycle-claude-fable-5-1')).toHaveTextContent('Archived');
    expect(screen.queryByTestId('model-row-claude-opus-5')).not.toBeInTheDocument();
    expect(screen.queryByTestId('model-lifecycle-claude-fable-5-2')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Show archived' }));
    expect(await screen.findByTestId('model-row-claude-opus-5')).toBeInTheDocument();
    expect(screen.getByTestId('model-lifecycle-claude-opus-5')).toHaveTextContent('Archived');
  });

  it('keeps an archived model listed after the user switches it off', async () => {
    const props = catalogProps({ models: ARCHIVED });
    const { rerender } = render(<ModelCatalog {...props} />);
    await userEvent.click(screen.getByTestId('model-catalog-expand-all'));
    const fable = screen.getByRole('switch', { name: 'Enable Claude Fable 5.1' });
    expect(fable).toBeChecked();
    await userEvent.click(fable);
    expect(props.onToggle).toHaveBeenCalledWith('claude-fable-5-1', false);
    // The store applies the switch optimistically: the row is now off.
    rerender(
      <ModelCatalog
        {...props}
        models={ARCHIVED.map((model) =>
          model.id === 'claude-fable-5-1' ? { ...model, isEnabled: false } : model
        )}
      />
    );
    expect(screen.getByRole('switch', { name: 'Enable Claude Fable 5.1' })).not.toBeChecked();
    expect(screen.getByTestId('model-lifecycle-claude-fable-5-1')).toHaveTextContent('Archived');
    // An archived model the user never had on stays hidden.
    expect(screen.queryByTestId('model-row-claude-opus-5')).not.toBeInTheDocument();
  });

  it('counts only the rows Enable can switch on while filtering', async () => {
    render(<ModelCatalog {...catalogProps({ models: ARCHIVED })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show archived' }));
    await userEvent.type(search(), 'claude');
    const header = await screen.findByTestId('model-catalog-section-anthropic');
    expect(within(header).getByText('3 shown')).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Enable 1 shown' })).toBeInTheDocument();
  });

  it('offers Show archived when only archived models match', async () => {
    render(<ModelCatalog {...catalogProps({ models: ARCHIVED })} />);
    await userEvent.type(search(), 'opus 5');
    const empty = await screen.findByTestId('model-catalog-no-matches');
    expect(
      within(empty).getByText('Only archived models match. Show archived lists them.')
    ).toBeInTheDocument();
    await userEvent.click(within(empty).getByRole('button', { name: 'Show archived' }));
    expect(await screen.findByTestId('model-row-claude-opus-5')).toBeInTheDocument();
  });

  it("names a deprecated model's retirement day", async () => {
    render(<ModelCatalog {...catalogProps({ models: ARCHIVED })} />);
    expect(await screen.findByTestId('model-lifecycle-gpt-5.4-nano')).toHaveTextContent(
      'Retires Apr 1, 2027'
    );
  });

  it('never bulk-enables an archived model, even when it is shown', async () => {
    const props = catalogProps({ models: ARCHIVED });
    render(<ModelCatalog {...props} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show archived' }));
    await userEvent.click(screen.getByTestId('model-catalog-enable-anthropic'));
    expect(props.onBulkChange).toHaveBeenCalledWith({
      enabled: true,
      modelIds: ['claude-fable-5-2'],
      scopeLabel: 'Anthropic',
    });
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
    expect(screen.queryByText(/per million tokens/u)).not.toBeInTheDocument();
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

// Ported from the deleted model-list.test.tsx (BST-1805 spec §10 step 3).
describe('ModelCatalog behaviour ported from ModelList', () => {
  const PORTED_PROVIDERS = [
    makeDbProvider('google', 'Google', 0),
    makeDbProvider('openai', 'OpenAI', 1),
  ];
  const PORTED_MODELS = [
    makeDbModel({
      id: 'gemini-lite',
      isEnabled: true,
      name: 'Gemini Lite',
      providerId: 'google',
      sortOrder: 0,
    }),
    makeDbModel({ id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', providerId: 'openai', sortOrder: 1 }),
    makeDbModel({
      id: 'mystery-model',
      name: 'Mystery Model',
      providerId: 'missing-provider',
      sortOrder: 2,
    }),
  ];

  function portedProps(overrides: Partial<ModelCatalogProps> = {}): ModelCatalogProps {
    return catalogProps({
      models: PORTED_MODELS,
      providers: PORTED_PROVIDERS,
      ...overrides,
    });
  }

  it('keeps a model whose provider row is missing visible under Unknown provider', async () => {
    render(<ModelCatalog {...portedProps()} />);
    const unknown = screen.getByTestId('model-catalog-section-__unknown-provider__');
    expect(within(unknown).getByText('Unknown provider')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('model-catalog-expand-all'));
    expect(within(unknown).getByTestId('model-row-mystery-model')).toBeInTheDocument();
  });

  it('filters rows by search and keeps the settings search-field layout', async () => {
    render(<ModelCatalog {...portedProps()} />);
    expect(search().style.paddingLeft).toBe('2.5rem');
    expect(
      search().parentElement?.querySelector<HTMLElement>('[data-slot="settings-search-icon"]')
        ?.style.left
    ).toBe('0.75rem');
    await userEvent.type(search(), 'terra');
    expect(await screen.findByTestId('model-row-gpt-5.6-terra')).toBeInTheDocument();
    expect(screen.queryByTestId('model-row-gemini-lite')).not.toBeInTheDocument();
  });

  it('toggles a model on and an enabled model off', async () => {
    const props = portedProps();
    render(<ModelCatalog {...props} />);
    await userEvent.click(screen.getByTestId('model-catalog-expand-all'));
    await userEvent.click(screen.getByTestId('model-toggle-gpt-5.6-terra'));
    expect(props.onToggle).toHaveBeenCalledWith('gpt-5.6-terra', true);
    await userEvent.click(screen.getByTestId('model-toggle-gemini-lite'));
    expect(props.onToggle).toHaveBeenCalledWith('gemini-lite', false);
  });

  it('disables a model switch while its write is in flight', async () => {
    const props = portedProps({ busyModelIds: new Set(['gpt-5.6-terra']) });
    render(<ModelCatalog {...props} />);
    await userEvent.click(screen.getByTestId('model-catalog-expand-all'));
    const busySwitch = screen.getByTestId('model-toggle-gpt-5.6-terra');
    expect(busySwitch).toBeDisabled();
    expect(busySwitch).toHaveAttribute('aria-busy', 'true');
    expect(props.onToggle).not.toHaveBeenCalled();
  });
});
