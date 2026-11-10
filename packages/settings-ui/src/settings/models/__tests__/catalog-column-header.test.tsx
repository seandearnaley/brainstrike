import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CatalogColumnHeader } from '../catalog-column-header';
import { getCatalogColumnLayout } from '../catalog-columns';
import { installCatalogDomStubs } from './catalog-dom-harness';

beforeAll(() => {
  installCatalogDomStubs({ width: null });
});

const scrollerRef = { current: null };

describe('CatalogColumnHeader', () => {
  it('is ONE presentational table whose sort controls stay in the accessibility tree', () => {
    const { container } = render(
      <CatalogColumnHeader
        layout={getCatalogColumnLayout('wide')}
        onSortChange={vi.fn()}
        scrollerRef={scrollerRef}
        sort={null}
      />
    );
    expect(container.querySelectorAll('table[role="presentation"]')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Model: sort ascending' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Context: sort ascending' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Max output: sort ascending' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Input price: sort ascending' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Output price: sort ascending' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cache/u })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Capabilities/u })).not.toBeInTheDocument();
  });

  it('cycles ascending → descending → catalog order', async () => {
    const onSortChange = vi.fn();
    const layout = getCatalogColumnLayout('wide');
    const { rerender } = render(
      <CatalogColumnHeader
        layout={layout}
        onSortChange={onSortChange}
        scrollerRef={scrollerRef}
        sort={null}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Context: sort ascending' }));
    expect(onSortChange).toHaveBeenLastCalledWith({ column: 'context', direction: 'asc' });

    rerender(
      <CatalogColumnHeader
        layout={layout}
        onSortChange={onSortChange}
        scrollerRef={scrollerRef}
        sort={{ column: 'context', direction: 'asc' }}
      />
    );
    const ascending = screen.getByRole('button', {
      name: 'Context: sorted ascending; sort descending',
    });
    expect(ascending.closest('th')).toHaveAttribute('aria-sort', 'ascending');
    await userEvent.click(ascending);
    expect(onSortChange).toHaveBeenLastCalledWith({ column: 'context', direction: 'desc' });

    rerender(
      <CatalogColumnHeader
        layout={layout}
        onSortChange={onSortChange}
        scrollerRef={scrollerRef}
        sort={{ column: 'context', direction: 'desc' }}
      />
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Context: sorted descending; restore default order' })
    );
    expect(onSortChange).toHaveBeenLastCalledWith(null);
  });

  it('heads each rate with its unit and sorts by it at the widest tier', async () => {
    const onSortChange = vi.fn();
    render(
      <CatalogColumnHeader
        layout={getCatalogColumnLayout('xwide')}
        onSortChange={onSortChange}
        scrollerRef={scrollerRef}
        sort={null}
      />
    );
    const cacheWrite = screen.getByRole('button', { name: 'Cache write price: sort ascending' });
    expect(cacheWrite).toHaveTextContent('Cache write$ / 1M');
    expect(screen.getAllByText('$ / 1M')).toHaveLength(4);
    await userEvent.click(screen.getByRole('button', { name: 'Cache read price: sort ascending' }));
    expect(onSortChange).toHaveBeenLastCalledWith({ column: 'cacheRead', direction: 'asc' });
  });

  it('renders the narrow tier with the compact Caps label and no rates or Max out', () => {
    render(
      <CatalogColumnHeader
        layout={getCatalogColumnLayout('narrow')}
        onSortChange={vi.fn()}
        scrollerRef={scrollerRef}
        sort={null}
      />
    );
    expect(screen.getByText('Caps')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /price/u })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Max output/u })).not.toBeInTheDocument();
  });
});
