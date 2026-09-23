import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, useRef, useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type CatalogFilters,
  DEFAULT_CATALOG_FILTERS,
  describeActiveFilters,
} from '../catalog-filters';
import type { CatalogProviderStat, CatalogSummary } from '../catalog-sections';
import { CatalogToolbar } from '../catalog-toolbar';
import { installCatalogDomStubs } from './catalog-dom-harness';

beforeAll(() => {
  installCatalogDomStubs({ width: null });
});

const PROVIDERS: CatalogProviderStat[] = [
  { enabledCount: 1, providerId: 'openai', providerName: 'OpenAI', totalCount: 15 },
  { enabledCount: 0, providerId: 'anthropic', providerName: 'Anthropic', totalCount: 7 },
];

const UNFILTERED: CatalogSummary = {
  enabledModels: 27,
  filtering: false,
  matchingModels: 122,
  matchingProviders: 10,
  totalModels: 122,
  totalProviders: 10,
};

const FILTERED: CatalogSummary = {
  enabledModels: 27,
  filtering: true,
  matchingModels: 17,
  matchingProviders: 3,
  totalModels: 122,
  totalProviders: 10,
};

function Harness({
  compact = false,
  initial = DEFAULT_CATALOG_FILTERS,
  onChange,
  summary = UNFILTERED,
}: {
  readonly compact?: boolean;
  readonly initial?: CatalogFilters;
  readonly onChange?: (next: CatalogFilters) => void;
  readonly summary?: CatalogSummary;
}) {
  const [filters, setFilters] = useState<CatalogFilters>(initial);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  return (
    <CatalogToolbar
      chips={describeActiveFilters(filters, new Map([['openai', 'OpenAI']]))}
      compact={compact}
      filters={filters}
      onClearAll={() => setFilters(DEFAULT_CATALOG_FILTERS)}
      onClearChip={vi.fn()}
      onCollapseAll={vi.fn()}
      onExpandAll={vi.fn()}
      onFiltersChange={(next) => {
        setFilters(next);
        onChange?.(next);
      }}
      providerOptions={PROVIDERS}
      searchInputRef={searchInputRef}
      summary={summary}
    />
  );
}

describe('CatalogToolbar', () => {
  it('summarises the unfiltered catalog', () => {
    render(<Harness />);
    expect(screen.getByTestId('model-catalog-summary')).toHaveTextContent(
      '122 models · 10 providers · 27 enabled'
    );
    expect(screen.getByTestId('model-catalog-summary')).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByTestId('model-catalog-clear-filters')).not.toBeInTheDocument();
  });

  it('summarises matches while filtering and offers Clear filters', () => {
    render(<Harness initial={{ ...DEFAULT_CATALOG_FILTERS, vision: true }} summary={FILTERED} />);
    expect(screen.getByTestId('model-catalog-summary')).toHaveTextContent(
      '17 of 122 models match · 3 providers'
    );
    expect(screen.getByTestId('model-catalog-clear-filters')).toBeInTheDocument();
  });

  it('types into search, then Esc clears and a second Esc blurs', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const search = screen.getByRole('searchbox', { name: 'Search models' });
    await userEvent.type(search, 'claude');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'claude' }));
    await userEvent.keyboard('{Escape}');
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(search).not.toHaveFocus();
  });

  it('switches status and type with native radio groups (Type defaults to All)', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const type = screen.getByRole('radiogroup', { name: 'Type' });
    expect(within(type).getByRole('radio', { name: 'All' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'Enabled' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'enabled' }));
    await userEvent.click(within(type).getByRole('radio', { name: 'Embedding' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'embedding' }));
  });

  it('toggles the Vision and Reasoning chips', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const vision = screen.getByRole('button', { name: 'Vision' });
    expect(vision).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(vision);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ vision: true }));
    expect(screen.getByRole('button', { name: 'Vision' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Reasoning' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ reasoning: true }));
  });

  it('filters by provider from the Providers popover', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByTestId('model-catalog-providers-trigger'));
    await userEvent.click(await screen.findByRole('checkbox', { name: /OpenAI/ }));
    const last = onChange.mock.lastCall?.[0] as CatalogFilters | undefined;
    expect([...(last?.providerIds ?? [])]).toEqual(['openai']);
    await userEvent.click(screen.getByRole('checkbox', { name: /OpenAI/ }));
    const cleared = onChange.mock.lastCall?.[0] as CatalogFilters | undefined;
    expect([...(cleared?.providerIds ?? ['unchanged'])]).toEqual([]);
  });

  it('picks a minimum context band from the Context select', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const trigger = screen.getByTestId('model-catalog-context-trigger');
    expect(trigger).toHaveTextContent('Context:Any');
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole('option', { name: '≥ 200K' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ context: '200k' }));
    expect(screen.getByTestId('model-catalog-context-trigger')).toHaveTextContent('Context:≥ 200K');
  });

  it('removes one chip or clears every filter', async () => {
    const onClearAll = vi.fn();
    const onClearChip = vi.fn();
    const filters: CatalogFilters = { ...DEFAULT_CATALOG_FILTERS, query: 'claude', vision: true };
    render(
      <CatalogToolbar
        chips={describeActiveFilters(filters, new Map())}
        compact={false}
        filters={filters}
        onClearAll={onClearAll}
        onClearChip={onClearChip}
        onCollapseAll={vi.fn()}
        onExpandAll={vi.fn()}
        onFiltersChange={vi.fn()}
        providerOptions={PROVIDERS}
        searchInputRef={{ current: null }}
        summary={FILTERED}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove filter Vision' }));
    expect(onClearChip).toHaveBeenCalledWith('vision');
    expect(screen.getByText('"claude"')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('model-catalog-clear-filters'));
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });

  it('collapses Vision, Reasoning, Context and Providers into one Filters popover in compact mode', async () => {
    render(
      <Harness compact initial={{ ...DEFAULT_CATALOG_FILTERS, reasoning: true, vision: true }} />
    );
    expect(screen.queryByRole('button', { name: 'Vision' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('model-catalog-providers-trigger')).not.toBeInTheDocument();
    const trigger = screen.getByTestId('model-catalog-filters-trigger');
    expect(trigger).toHaveTextContent('Filters2');
    await userEvent.click(trigger);
    expect(await screen.findByRole('button', { name: 'Vision' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('checkbox', { name: /Anthropic/ })).toBeInTheDocument();
  });

  it('hands the search input to searchInputRef (Task 9 focuses it on "/")', () => {
    const searchInputRef = createRef<HTMLInputElement>();
    render(
      <CatalogToolbar
        chips={[]}
        compact={false}
        filters={DEFAULT_CATALOG_FILTERS}
        onClearAll={vi.fn()}
        onClearChip={vi.fn()}
        onCollapseAll={vi.fn()}
        onExpandAll={vi.fn()}
        onFiltersChange={vi.fn()}
        providerOptions={PROVIDERS}
        searchInputRef={searchInputRef}
        summary={UNFILTERED}
      />
    );
    expect(searchInputRef.current).toBe(screen.getByRole('searchbox', { name: 'Search models' }));
  });

  it('wires Expand all and Collapse all', async () => {
    const onExpandAll = vi.fn();
    const onCollapseAll = vi.fn();
    render(
      <CatalogToolbar
        chips={[]}
        compact={false}
        filters={DEFAULT_CATALOG_FILTERS}
        onClearAll={vi.fn()}
        onClearChip={vi.fn()}
        onCollapseAll={onCollapseAll}
        onExpandAll={onExpandAll}
        onFiltersChange={vi.fn()}
        providerOptions={PROVIDERS}
        searchInputRef={{ current: null }}
        summary={UNFILTERED}
      />
    );
    await userEvent.click(screen.getByTestId('model-catalog-expand-all'));
    await userEvent.click(screen.getByTestId('model-catalog-collapse-all'));
    expect(onExpandAll).toHaveBeenCalledTimes(1);
    expect(onCollapseAll).toHaveBeenCalledTimes(1);
  });
});
