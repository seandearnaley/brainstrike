import '@testing-library/jest-dom/vitest';
import { STICKY_SECTION_HEADER_LAYER_CLASS } from '@brainstrike/ui';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getCatalogColumns } from '../catalog-columns';
import { createCatalogNodeCache } from '../catalog-nodes';
import { CatalogSection, type CatalogSectionProps } from '../catalog-section';
import type { CatalogSection as CatalogSectionModel } from '../catalog-sections';
import { CatalogRowActionsContext } from '../use-catalog-row-actions';
import { installCatalogDomStubs, makeRowActions } from './catalog-dom-harness';
import { makeCatalogRow } from './catalog-test-harness';

const virtualizerOptions = vi.hoisted(() => ({
  current: [] as Array<{ count: number; scrollPaddingStart?: number }>,
}));

vi.mock('@tanstack/react-virtual', async () => {
  const actual =
    await vi.importActual<typeof import('@tanstack/react-virtual')>('@tanstack/react-virtual');
  const { createMockCatalogVirtualizer } =
    await vi.importActual<typeof import('./catalog-dom-harness')>('./catalog-dom-harness');
  return {
    ...actual,
    useVirtualizer: (options: { count: number; scrollPaddingStart?: number }) => {
      virtualizerOptions.current.push(options);
      return createMockCatalogVirtualizer(options);
    },
  };
});

beforeAll(() => {
  installCatalogDomStubs({ width: null });
});

const SECTION: CatalogSectionModel = {
  enabledCount: 1,
  providerId: 'openai',
  providerName: 'OpenAI',
  rows: [
    makeCatalogRow({ enabled: true, id: 'gpt-a', name: 'GPT A', providerId: 'openai' }),
    makeCatalogRow({ enabled: false, id: 'gpt-b', name: 'GPT B', providerId: 'openai' }),
  ],
  runtimeLabel: 'Hosted',
  totalCount: 3,
};

function renderSection(overrides: Partial<CatalogSectionProps> = {}) {
  const props: CatalogSectionProps = {
    busyModelIds: new Set<string>(),
    columns: getCatalogColumns('wide'),
    compact: false,
    detailsOpenIds: new Set<string>(),
    expanded: true,
    filtering: false,
    getNodes: createCatalogNodeCache(),
    onBulkChange: vi.fn(),
    onToggleDetails: vi.fn(),
    onToggleModel: vi.fn(),
    onToggleSection: vi.fn(),
    scrollParentRef: { current: document.createElement('div') },
    section: SECTION,
    ...overrides,
  };
  render(
    <CatalogRowActionsContext value={makeRowActions()}>
      <CatalogSection {...props} />
    </CatalogRowActionsContext>
  );
  return props;
}

describe('CatalogSection header', () => {
  it('is a sticky, token-layered header with one disclosure inside an h3', async () => {
    const props = renderSection();
    const header = screen.getByTestId('model-catalog-section-header-openai');
    // Pin the literal classes (Tailwind scans source text; see ui-conventions).
    expect(header.className).toContain('sticky');
    expect(header.className).toContain('top-0');
    expect(header.className).toContain(STICKY_SECTION_HEADER_LAYER_CLASS);

    const heading = within(header).getByRole('heading', { level: 3 });
    const disclosure = within(heading).getByRole('button', { name: /OpenAI/ });
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    const regionId = disclosure.getAttribute('aria-controls');
    expect(regionId).toBeTruthy();
    expect(document.getElementById(regionId ?? '')).toContainElement(
      screen.getByRole('treegrid', { name: 'OpenAI models' })
    );
    expect(within(heading).queryByRole('button', { name: /Enable/ })).not.toBeInTheDocument();

    await userEvent.click(disclosure);
    expect(props.onToggleSection).toHaveBeenCalledWith('openai');
  });

  it('truncates a long provider name inside the header instead of painting over the count', () => {
    renderSection({ section: { ...SECTION, providerName: 'Amazon Bedrock' } });
    const header = screen.getByTestId('model-catalog-section-header-openai');
    const heading = within(header).getByRole('heading', { level: 3 });
    const disclosure = within(heading).getByRole('button', { name: /Amazon Bedrock/ });
    const name = within(disclosure).getByText('Amazon Bedrock');
    // A button is shrink-to-fit even as display:flex, so the h3 must itself be a
    // shrinkable flex container and the button a min-w-0 flex item capped at the
    // h3 width; only then can the name's `truncate` engage (live defect at 900px).
    const headingClasses = heading.className.split(' ');
    expect(headingClasses).toEqual(expect.arrayContaining(['flex', 'min-w-0']));
    const disclosureClasses = disclosure.className.split(' ');
    expect(disclosureClasses).toEqual(expect.arrayContaining(['min-w-0', 'max-w-full']));
    expect(name.className.split(' ')).toContain('truncate');
    // The clipped name stays available in full to pointer users.
    expect(name).toHaveAttribute('title', 'Amazon Bedrock');
  });

  it('shows the runtime tag, the enabled meter text, and unfiltered bulk labels', () => {
    renderSection();
    const header = screen.getByTestId('model-catalog-section-header-openai');
    expect(within(header).getByText('Hosted')).toBeInTheDocument();
    expect(screen.getByTestId('model-catalog-section-count-openai')).toHaveTextContent(
      '1 / 3 enabled'
    );
    expect(within(header).getByRole('button', { name: 'Enable all' })).toBeEnabled();
    expect(within(header).getByRole('button', { name: 'Disable all' })).toBeEnabled();
    expect(within(header).queryByText(/shown/)).not.toBeInTheDocument();
  });

  it('scopes the labels to the shown rows while filtering', () => {
    renderSection({ filtering: true });
    const header = screen.getByTestId('model-catalog-section-header-openai');
    expect(within(header).getByText('2 shown')).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Enable 2 shown' })).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'Disable 2 shown' })).toBeInTheDocument();
  });

  it('disables a bulk action with nothing to change and reports the section otherwise', async () => {
    const allOn: CatalogSectionModel = {
      ...SECTION,
      rows: [makeCatalogRow({ enabled: true, id: 'gpt-a', name: 'GPT A' })],
    };
    const props = renderSection({ section: allOn });
    expect(screen.getByTestId('model-catalog-enable-openai')).toBeDisabled();
    await userEvent.click(screen.getByTestId('model-catalog-disable-openai'));
    expect(props.onBulkChange).toHaveBeenCalledWith(allOn, false);
  });

  it('mirrors that for an all-off section: Disable is inert, Enable reports the section', async () => {
    const allOff: CatalogSectionModel = {
      ...SECTION,
      rows: [makeCatalogRow({ enabled: false, id: 'gpt-b', name: 'GPT B' })],
    };
    const props = renderSection({ section: allOff });
    expect(screen.getByTestId('model-catalog-disable-openai')).toBeDisabled();
    await userEvent.click(screen.getByTestId('model-catalog-enable-openai'));
    expect(props.onBulkChange).toHaveBeenCalledWith(allOff, true);
  });

  it('disables both bulk actions while any shown row has a write in flight', () => {
    // The busy set is not reference-counted, so a bulk write overlapping an
    // in-flight toggle could snapshot an uncommitted optimistic state for Undo.
    renderSection({ busyModelIds: new Set(['gpt-b']) });
    expect(screen.getByTestId('model-catalog-enable-openai')).toBeDisabled();
    expect(screen.getByTestId('model-catalog-disable-openai')).toBeDisabled();
  });

  it('ignores a busy model that is not one of the shown rows', () => {
    renderSection({ busyModelIds: new Set(['gpt-hidden']) });
    expect(screen.getByTestId('model-catalog-enable-openai')).toBeEnabled();
    expect(screen.getByTestId('model-catalog-disable-openai')).toBeEnabled();
  });

  it('drops the runtime tag and meter in compact mode but keeps counts and bulk actions', () => {
    renderSection({ compact: true });
    const header = screen.getByTestId('model-catalog-section-header-openai');
    expect(within(header).queryByText('Hosted')).not.toBeInTheDocument();
    expect(screen.getByTestId('model-catalog-section-count-openai')).toBeInTheDocument();
    expect(screen.getByTestId('model-catalog-enable-openai')).toBeInTheDocument();
  });

  it('reserves the sticky header height when bringing a focused row into view', () => {
    // WCAG 2.4.11: keyboard focus must not land under the in-scroller sticky
    // header. The inset and the header's h-11 class (44px) move together.
    virtualizerOptions.current.length = 0;
    renderSection();
    expect(screen.getByTestId('model-catalog-section-header-openai').className).toContain('h-11');
    expect(virtualizerOptions.current.at(-1)?.scrollPaddingStart).toBe(44);
  });

  it('renders no treegrid while collapsed', () => {
    renderSection({ expanded: false });
    expect(screen.queryByRole('treegrid')).not.toBeInTheDocument();
    expect(screen.getByTestId('model-catalog-section-toggle-openai')).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });
});

describe('CatalogSection keyboard', () => {
  it('Space toggles the focused row, Enter and → open its details', () => {
    const props = renderSection();
    const grid = screen.getByRole('treegrid', { name: 'OpenAI models' });
    fireEvent.keyDown(grid, { key: 'ArrowDown' }); // activates roving focus on the first row
    fireEvent.keyDown(grid, { key: ' ' });
    expect(props.onToggleModel).toHaveBeenCalledWith('gpt-a', false);
    fireEvent.keyDown(grid, { key: 'Enter' });
    expect(props.onToggleDetails).toHaveBeenLastCalledWith('gpt-a');
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    expect(props.onToggleDetails).toHaveBeenLastCalledWith('gpt-a');
  });

  it('Space does nothing while that row is busy', () => {
    const props = renderSection({ busyModelIds: new Set(['gpt-a']) });
    const grid = screen.getByRole('treegrid', { name: 'OpenAI models' });
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: ' ' });
    expect(props.onToggleModel).not.toHaveBeenCalled();
  });
});

describe('CatalogSection details and pointer', () => {
  it('← closes an open details row', () => {
    const props = renderSection({ detailsOpenIds: new Set(['gpt-a']) });
    const grid = screen.getByRole('treegrid', { name: 'OpenAI models' });
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: 'ArrowLeft' });
    expect(props.onToggleDetails).toHaveBeenCalledWith('gpt-a');
  });

  it('a pointer click on a model row selects nothing', async () => {
    const props = renderSection();
    const row = screen.getByRole('row', { name: /GPT A/ });
    await userEvent.click(within(row).getByText('GPT A'));
    expect(props.onToggleDetails).not.toHaveBeenCalled();
    expect(props.onToggleModel).not.toHaveBeenCalled();
    expect(row).not.toHaveAttribute('aria-selected', 'true');
  });
});
