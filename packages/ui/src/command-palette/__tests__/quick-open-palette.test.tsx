import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type QuickOpenFileItem, QuickOpenPalette } from '../quick-open-palette';

// Radix Dialog + cmdk rely on a few DOM APIs happy-dom does not implement.
global.ResizeObserver = class ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn();

function makeFile(
  overrides: Partial<QuickOpenFileItem> & Pick<QuickOpenFileItem, 'id'>
): QuickOpenFileItem {
  return {
    compositeKey: 'root-a|@|src/index.ts',
    name: 'index.ts',
    path: 'src/index.ts',
    rootLabel: 'Alpha',
    ...overrides,
  };
}

describe('QuickOpenPalette', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders an accessible DialogTitle + Description (Radix requires them, unconditionally)', async () => {
    render(
      <QuickOpenPalette
        files={[]}
        onOpenChange={() => {}}
        onQueryChange={() => {}}
        onSelect={() => {}}
        open
        query=""
      />
    );
    // The Radix DialogTitle renders an <h2> (role heading); cmdk also renders a
    // <label> with the same text, so query the heading specifically. These
    // visually-hidden nodes satisfy @radix-ui/react-dialog's unconditional
    // accessibility warning (caught live via CDT, not in jsdom).
    expect(await screen.findByRole('heading', { name: 'Quick open file' })).toBeTruthy();
    expect(screen.getByText('Search for a file by name and press Enter to open it.')).toBeTruthy();
    // Declared modal, so the tab chord router leaves keys typed here alone.
    expect(screen.getByRole('dialog', { name: 'Quick open file' })).toHaveAttribute(
      'aria-modal',
      'true'
    );
  });

  it('renders the file rows as a listbox with name, path and root label', async () => {
    const files: QuickOpenFileItem[] = [
      makeFile({ id: 'a', name: 'readme.md', path: 'docs/readme.md', rootLabel: 'Alpha' }),
    ];
    render(
      <QuickOpenPalette
        files={files}
        onOpenChange={() => {}}
        onQueryChange={() => {}}
        onSelect={() => {}}
        open
        query="read"
      />
    );

    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('readme.md')).toBeTruthy();
    expect(within(listbox).getByText('docs/readme.md')).toBeTruthy();
    expect(within(listbox).getByText('Alpha')).toBeTruthy();
    const options = within(listbox).getAllByRole('option');
    expect(options.some((option) => option.getAttribute('aria-selected') === 'true')).toBe(true);
  });

  it('opens the correct root when the same path exists in two roots', async () => {
    // Multi-root open correctness: two identical-path rows differ only by
    // compositeKey (root-prefixed). Selecting the Beta row must hand back Beta's
    // compositeKey, never Alpha's.
    const onSelect = vi.fn();
    const files: QuickOpenFileItem[] = [
      makeFile({ compositeKey: 'root-a|@|src/index.ts', id: 'a', rootLabel: 'Alpha' }),
      makeFile({ compositeKey: 'root-b|@|src/index.ts', id: 'b', rootLabel: 'Beta' }),
    ];
    render(
      <QuickOpenPalette
        files={files}
        onOpenChange={() => {}}
        onQueryChange={() => {}}
        onSelect={onSelect}
        open
        query="index"
      />
    );

    const betaRow = await screen.findByText('Beta');
    fireEvent.click(betaRow);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]?.compositeKey).toBe('root-b|@|src/index.ts');
  });

  it('does not locally filter — it renders exactly the rows it is given', async () => {
    // The SQL ILIKE is the filter; the palette must not drop rows whose name
    // does not contain the query string (shouldFilter is false).
    const files: QuickOpenFileItem[] = [
      makeFile({ id: 'a', name: 'totally-different.ts', path: 'src/totally-different.ts' }),
    ];
    render(
      <QuickOpenPalette
        files={files}
        onOpenChange={() => {}}
        onQueryChange={() => {}}
        onSelect={() => {}}
        open
        query="zzz"
      />
    );

    expect(await screen.findByText('totally-different.ts')).toBeTruthy();
  });

  it('shows an honest empty state when a query returns no files', async () => {
    render(
      <QuickOpenPalette
        files={[]}
        onOpenChange={() => {}}
        onQueryChange={() => {}}
        onSelect={() => {}}
        open
        query="nothing"
      />
    );
    expect(await screen.findByText('No files found.')).toBeTruthy();
  });

  it('prompts to type when the query is empty', async () => {
    render(
      <QuickOpenPalette
        files={[]}
        onOpenChange={() => {}}
        onQueryChange={() => {}}
        onSelect={() => {}}
        open
        query=""
      />
    );
    expect(await screen.findByText('Type to search files.')).toBeTruthy();
  });

  it('shows a loading state while the live query resolves', async () => {
    render(
      <QuickOpenPalette
        files={[]}
        loading
        onOpenChange={() => {}}
        onQueryChange={() => {}}
        onSelect={() => {}}
        open
        query="re"
      />
    );
    expect(await screen.findByText('Searching…')).toBeTruthy();
  });

  it('resets the query and closes when a file is selected', async () => {
    const onOpenChange = vi.fn();
    const onQueryChange = vi.fn();
    const files: QuickOpenFileItem[] = [makeFile({ id: 'a', name: 'pick.ts' })];
    render(
      <QuickOpenPalette
        files={files}
        onOpenChange={onOpenChange}
        onQueryChange={onQueryChange}
        onSelect={() => {}}
        open
        query="pick"
      />
    );

    fireEvent.click(await screen.findByText('pick.ts'));
    expect(onQueryChange).toHaveBeenCalledWith('');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
