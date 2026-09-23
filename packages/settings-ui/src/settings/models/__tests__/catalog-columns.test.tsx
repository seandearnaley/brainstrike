import '@testing-library/jest-dom/vitest';
import { TreeTable } from '@brainstrike/ui';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type CatalogWidthTier,
  getCatalogColumnLayout,
  getCatalogColumns,
  resolveCatalogWidthTier,
} from '../catalog-columns';
import { buildSectionNodes, createCatalogNodeCache } from '../catalog-nodes';
import type { CatalogRow } from '../catalog-projection';
import { type CatalogRowActions, CatalogRowActionsContext } from '../use-catalog-row-actions';
import { installCatalogDomStubs, makeRowActions } from './catalog-dom-harness';
import { makeCatalogRow } from './catalog-test-harness';

vi.mock('@tanstack/react-virtual', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-virtual')>('@tanstack/react-virtual');
  const { createMockCatalogVirtualizer } =
    await vi.importActual<typeof import('./catalog-dom-harness')>('./catalog-dom-harness');
  return { ...actual, useVirtualizer: createMockCatalogVirtualizer };
});

beforeAll(() => {
  installCatalogDomStubs({ width: null });
});

function renderRows(
  rows: readonly CatalogRow[],
  options: {
    readonly actions?: Partial<CatalogRowActions>;
    readonly expandedIds?: readonly string[];
    readonly tier?: CatalogWidthTier;
  } = {}
) {
  return render(
    <CatalogRowActionsContext value={makeRowActions(options.actions)}>
      <TreeTable
        ariaLabel="Test models"
        columns={getCatalogColumns(options.tier ?? 'wide')}
        expandedIds={new Set(options.expandedIds ?? [])}
        nodes={buildSectionNodes(rows, createCatalogNodeCache())}
        onToggleExpand={vi.fn()}
        scrollParentRef={{ current: document.createElement('div') }}
        showHeader={false}
        windowingStrategy="virtual"
      />
    </CatalogRowActionsContext>
  );
}

const TERRA = makeCatalogRow({
  contextWindow: 1_050_000,
  id: 'gpt-5.6-terra',
  maxOutputTokens: 128_000,
  name: 'GPT-5.6 Terra',
  pricing: {
    cacheReadPerMTok: null,
    cacheWritePerMTok: null,
    inputPerMTok: 2.5,
    outputPerMTok: 15,
  },
  providerId: 'openai',
  recommended: true,
  tagline: 'Most capable for everyday work',
});

describe('resolveCatalogWidthTier', () => {
  it.each([
    [1200, 'wide'],
    [900, 'wide'],
    [899, 'medium'],
    [640, 'medium'],
    [639, 'narrow'],
    [525, 'narrow'],
  ] as const)('%i px → %s', (width, tier) => {
    expect(resolveCatalogWidthTier(width)).toBe(tier);
  });
});

describe('catalog column layouts', () => {
  it('drops Max out below 900px and Price below 640px', () => {
    expect(getCatalogColumnLayout('wide').map((column) => column.id)).toEqual([
      'enabled',
      'model',
      'capabilities',
      'context',
      'maxOutput',
      'price',
      'actions',
    ]);
    expect(getCatalogColumnLayout('medium').map((column) => column.id)).toEqual([
      'enabled',
      'model',
      'capabilities',
      'context',
      'price',
      'actions',
    ]);
    expect(getCatalogColumnLayout('narrow').map((column) => column.id)).toEqual([
      'enabled',
      'model',
      'capabilities',
      'context',
      'actions',
    ]);
    expect(
      getCatalogColumnLayout('narrow').find((column) => column.id === 'capabilities')?.label
    ).toBe('Caps');
  });

  it('returns identity-stable column definitions per tier', () => {
    expect(getCatalogColumns('wide')).toBe(getCatalogColumns('wide'));
    expect(getCatalogColumns('narrow')).toBe(getCatalogColumns('narrow'));
  });
});

describe('catalog model rows', () => {
  it('renders one line: switch, name, tag, tagline, capabilities, context, max out and price', () => {
    renderRows([TERRA]);
    const cell = screen.getByTestId('model-row-gpt-5.6-terra');
    expect(within(cell).getByText('GPT-5.6 Terra')).toHaveAttribute('title', 'gpt-5.6-terra');
    expect(within(cell).getByText('Recommended')).toBeInTheDocument();
    expect(within(cell).getByText('Most capable for everyday work')).toBeInTheDocument();
    expect(screen.getByText('1,050,000 token context window')).toBeInTheDocument();
    expect(screen.getByText('128,000 token max output')).toBeInTheDocument();
    expect(screen.getByText('input $2.50, output $15 per million tokens')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Vision supported' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Reasoning supported' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Enable GPT-5.6 Terra' })).toHaveAttribute(
      'data-testid',
      'model-toggle-gpt-5.6-terra'
    );
  });

  it('shows an explicit dash for every unpublished fact, never 0', () => {
    renderRows([
      makeCatalogRow({
        contextWindow: null,
        id: 'bare',
        maxOutputTokens: null,
        pricing: null,
        reasoning: null,
        vision: null,
      }),
    ]);
    expect(screen.getByText('No published context window')).toBeInTheDocument();
    expect(screen.getByText('No published max output')).toBeInTheDocument();
    expect(screen.getByText('No published price')).toBeInTheDocument();
    expect(screen.getByText('No published capabilities')).toBeInTheDocument();
    const row = screen.getByTestId('model-row-bare').closest('tr');
    expect(row?.textContent).not.toMatch(/\$0|(^|\D)0K/);
  });

  it('labels an unknown reasoning state "unverified"', () => {
    renderRows([
      makeCatalogRow({
        id: 'or',
        reasoning: { reason: 'openrouter-undeclared', state: 'unknown' },
      }),
    ]);
    expect(screen.getByRole('img', { name: 'Reasoning unverified' })).toBeInTheDocument();
  });

  it('renders Free only when both rates are zero', () => {
    renderRows([
      makeCatalogRow({
        id: 'free',
        pricing: {
          cacheReadPerMTok: null,
          cacheWritePerMTok: null,
          inputPerMTok: 0,
          outputPerMTok: 0,
        },
      }),
    ]);
    expect(screen.getByText('Free')).toBeInTheDocument();
  });

  it('prices a row with one zero rate rather than calling it Free', () => {
    renderRows([
      makeCatalogRow({
        id: 'half-free',
        pricing: {
          cacheReadPerMTok: null,
          cacheWritePerMTok: null,
          inputPerMTok: 0,
          outputPerMTok: 0.4,
        },
      }),
    ]);
    expect(screen.queryByText('Free')).not.toBeInTheDocument();
    expect(screen.getByText('input $0, output $0.40 per million tokens')).toBeInTheDocument();
  });

  it('shows embedding dimensions and the Embedding tag while Type is All', () => {
    renderRows(
      [
        makeCatalogRow({
          dimension: 1536,
          id: 'text-embedding-3-small',
          reasoning: null,
          type: 'embedding',
          vision: null,
        }),
      ],
      { actions: { showTypeTag: true } }
    );
    expect(screen.getByText('1536-dimension embeddings')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('model-row-text-embedding-3-small')).getByText('Embedding')
    ).toBeInTheDocument();
  });

  it('drops the Embedding tag once Type is filtered', () => {
    renderRows([makeCatalogRow({ dimension: 1536, id: 'emb', type: 'embedding' })], {
      actions: { showTypeTag: false },
    });
    expect(
      within(screen.getByTestId('model-row-emb')).queryByText('Embedding')
    ).not.toBeInTheDocument();
  });

  it('swaps the tagline for the highlighted id when the query hits only the id', () => {
    renderRows(
      [
        makeCatalogRow({
          id: 'anthropic/claude-opus-5',
          name: 'Claude Opus 5',
          tagline: 'For complex agentic coding',
        }),
      ],
      { actions: { query: 'anthropic/' } }
    );
    const cell = screen.getByTestId('model-row-anthropic/claude-opus-5');
    expect(within(cell).queryByText('For complex agentic coding')).not.toBeInTheDocument();
    expect(cell.querySelector('mark')?.textContent).toBe('anthropic/');
  });

  it('highlights query matches in the name', () => {
    renderRows([makeCatalogRow({ id: 'claude-opus-5', name: 'Claude Opus 5' })], {
      actions: { query: 'opus' },
    });
    expect(screen.getByTestId('model-row-claude-opus-5').querySelector('mark')?.textContent).toBe(
      'Opus'
    );
  });

  it('hides Max out and Price at the narrow tier, and the tagline when showTagline is off', () => {
    renderRows([makeCatalogRow({ id: 'm', name: 'M', tagline: 'A tagline' })], {
      actions: { showTagline: false },
      tier: 'narrow',
    });
    expect(screen.queryByText(/token max output/)).not.toBeInTheDocument();
    expect(screen.queryByText(/per million tokens/)).not.toBeInTheDocument();
    expect(screen.queryByText('A tagline')).not.toBeInTheDocument();
  });

  it('routes the switch through onToggle', async () => {
    const onToggle = vi.fn();
    renderRows([makeCatalogRow({ id: 'm', name: 'M' })], { actions: { onToggle } });
    await userEvent.click(screen.getByRole('switch', { name: 'Enable M' }));
    expect(onToggle).toHaveBeenCalledWith('m', true);
  });

  it('disables the switch while its write is in flight', () => {
    renderRows([makeCatalogRow({ id: 'm', name: 'M' })], {
      actions: { busyModelIds: new Set(['m']) },
    });
    const busy = screen.getByRole('switch', { name: 'Enable M' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
  });

  it('toggles details from the row disclosure', async () => {
    const onToggleDetails = vi.fn();
    renderRows([makeCatalogRow({ id: 'm', name: 'M' })], { actions: { onToggleDetails } });
    const disclosure = screen.getByRole('button', { name: 'Show details for M' });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(disclosure);
    expect(onToggleDetails).toHaveBeenCalledWith('m');
  });

  it('offers a sized download for a local model', async () => {
    const onDownload = vi.fn();
    renderRows(
      [makeCatalogRow({ id: 'gemma', isLocal: true, name: 'Gemma', sizeLabel: '1.2 GB' })],
      {
        actions: { onDownload },
      }
    );
    await userEvent.click(screen.getByRole('button', { name: 'Download Gemma (1.2 GB)' }));
    expect(onDownload).toHaveBeenCalledWith('gemma');
  });

  it('shows download progress, then a downloaded mark', () => {
    const row = makeCatalogRow({ id: 'gemma', isLocal: true, name: 'Gemma' });
    const { unmount } = renderRows([row], {
      actions: { downloadProgress: { gemma: 40 }, isDownloading: { gemma: true } },
    });
    expect(screen.getByText('40%')).toBeInTheDocument();
    unmount();
    renderRows([row], { actions: { downloadedModels: { gemma: true } } });
    expect(screen.getByRole('img', { name: 'Gemma downloaded' })).toBeInTheDocument();
  });
});

describe('catalog details row', () => {
  it('renders every fact in full, spanning the whole row', () => {
    renderRows(
      [
        makeCatalogRow({
          bestFor: ['Coding'],
          contextWindow: 1_050_000,
          description: 'A frontier model.',
          id: 'claude-opus-5',
          maxOutputTokens: 128_000,
          name: 'Claude Opus 5',
          pricing: {
            cacheReadPerMTok: 0.5,
            cacheWritePerMTok: 6.25,
            inputPerMTok: 5,
            outputPerMTok: 25,
          },
          reasoningEfforts: ['low', 'high'],
        }),
      ],
      { expandedIds: ['claude-opus-5'] }
    );
    const details = screen.getByTestId('model-details-claude-opus-5');
    expect(within(details).getByText('claude-opus-5')).toBeInTheDocument();
    expect(
      within(details).getByRole('button', { name: 'Copy model ID claude-opus-5' })
    ).toBeInTheDocument();
    expect(within(details).getByText('1,050,000 · 128,000 tokens')).toBeInTheDocument();
    expect(within(details).getByText('Input $5 · Output $25 per 1M tokens')).toBeInTheDocument();
    expect(within(details).getByText('Cache read $0.50')).toBeInTheDocument();
    expect(within(details).getByText('Cache write $6.25')).toBeInTheDocument();
    expect(within(details).getByText('high')).toBeInTheDocument();
    expect(within(details).getByText('Coding')).toBeInTheDocument();
    expect(within(details).getByText('A frontier model.')).toBeInTheDocument();
    expect(details.closest('td')).toHaveAttribute(
      'colspan',
      String(getCatalogColumnLayout('wide').length)
    );
  });

  it('says Unverified for an unknown reasoning state and Not published for missing facts', () => {
    renderRows(
      [
        makeCatalogRow({
          contextWindow: null,
          id: 'or',
          maxOutputTokens: null,
          pricing: null,
          reasoning: { reason: 'openrouter-undeclared', state: 'unknown' },
          reasoningEfforts: null,
        }),
      ],
      { expandedIds: ['or'] }
    );
    const details = screen.getByTestId('model-details-or');
    expect(within(details).getByText('Unverified')).toBeInTheDocument();
    expect(within(details).getByText('Not published')).toBeInTheDocument();
    expect(within(details).getByText('No published price')).toBeInTheDocument();
  });

  it('shows the cache path for a downloaded local model', () => {
    renderRows([makeCatalogRow({ id: 'gemma', isLocal: true })], {
      actions: { downloadedModels: { gemma: true }, modelCacheDir: '/models' },
      expandedIds: ['gemma'],
    });
    expect(
      within(screen.getByTestId('model-details-gemma')).getByText('/models/gemma')
    ).toBeInTheDocument();
  });
});
