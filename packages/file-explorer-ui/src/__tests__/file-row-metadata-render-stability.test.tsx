/**
 * Render-stability contract for the per-row metadata seam (BST-1207).
 *
 * Extends the existing tree render-stability pins
 * (`optimized-file-tree-row-reuse.test.ts`, `packages/ui`'s
 * `tree-table-render-stability.test.tsx`) to the metadata cells: those pin that
 * a value-equal ROW rebuild re-renders nothing; this pins that a token count
 * arriving for ONE file re-renders only that file's cell (and the enumerated
 * ancestor directory whose rollup genuinely moved) — never the sibling rows,
 * and never through a row rebuild.
 */
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { act, render } from '@testing-library/react';
import { memo, useCallback, useSyncExternalStore } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  createFileRowMetadataStore,
  type FileRowMetadataSources,
  type FileRowMetadataStore,
} from '../indexing/file-row-metadata-store';

const ROOT = 'root-id';
const DIRECTORY_KEY = encodeFileSelection(ROOT, 'src');
const FILE_A = encodeFileSelection(ROOT, 'src/a.ts');
const FILE_B = encodeFileSelection(ROOT, 'src/b.ts');

const renderCounts = new Map<string, number>();

function countRender(label: string): void {
  renderCounts.set(label, (renderCounts.get(label) ?? 0) + 1);
}

const FileMetadataCell = memo(
  ({ compositeKey, store }: { compositeKey: string; store: FileRowMetadataStore }) => {
    const subscribe = useCallback(
      (listener: () => void) => store.subscribe(compositeKey, listener),
      [compositeKey, store]
    );
    const getSnapshot = useCallback(() => store.getSnapshot(compositeKey), [compositeKey, store]);
    const metadata = useSyncExternalStore(subscribe, getSnapshot);
    countRender(compositeKey);
    return <span data-testid={compositeKey}>{String(metadata.tokens)}</span>;
  }
);
FileMetadataCell.displayName = 'FileMetadataCell';

const DirectoryMetadataCell = memo(
  ({ compositeKey, store }: { compositeKey: string; store: FileRowMetadataStore }) => {
    const subscribe = useCallback(
      (listener: () => void) => store.subscribe(compositeKey, listener),
      [compositeKey, store]
    );
    const getSnapshot = useCallback(
      () => store.getDirectorySnapshot(compositeKey),
      [compositeKey, store]
    );
    const rollup = useSyncExternalStore(subscribe, getSnapshot);
    countRender(compositeKey);
    return (
      <span data-testid={compositeKey}>
        {rollup.status === 'complete' ? String(rollup.tokens) : rollup.reason}
      </span>
    );
  }
);
DirectoryMetadataCell.displayName = 'DirectoryMetadataCell';

function createStore(tokens: Record<string, number>): FileRowMetadataStore {
  const sources: FileRowMetadataSources = {
    getCachedSize: () => undefined,
    getDirectorySubtree: (compositeKey) =>
      compositeKey === DIRECTORY_KEY
        ? { fileKeys: [FILE_A, FILE_B], isComplete: true }
        : { fileKeys: [], isComplete: false },
    getNodeSize: (compositeKey) => (compositeKey === FILE_A ? 100 : 20),
    getTokenCount: (compositeKey) => tokens[compositeKey],
  };
  return createFileRowMetadataStore(sources);
}

describe('file row metadata render stability', () => {
  it('re-renders only the cell whose token count arrived', () => {
    renderCounts.clear();
    const tokens: Record<string, number> = {};
    const store = createStore(tokens);

    render(
      <>
        <FileMetadataCell compositeKey={FILE_A} store={store} />
        <FileMetadataCell compositeKey={FILE_B} store={store} />
      </>
    );

    expect(renderCounts.get(FILE_A)).toBe(1);
    expect(renderCounts.get(FILE_B)).toBe(1);

    tokens[FILE_A] = 42;
    act(() => {
      store.invalidate([FILE_A]);
    });

    expect(renderCounts.get(FILE_A)).toBe(2);
    expect(renderCounts.get(FILE_B)).toBe(1);
  });

  it('leaves every cell untouched when an invalidation changes nothing', () => {
    renderCounts.clear();
    const store = createStore({ [FILE_A]: 1, [FILE_B]: 2 });

    render(
      <>
        <FileMetadataCell compositeKey={FILE_A} store={store} />
        <FileMetadataCell compositeKey={FILE_B} store={store} />
      </>
    );

    act(() => {
      store.invalidateAll();
    });

    expect(renderCounts.get(FILE_A)).toBe(1);
    expect(renderCounts.get(FILE_B)).toBe(1);
  });

  it('re-renders the ancestor directory rollup but not the sibling file cell', () => {
    renderCounts.clear();
    const tokens: Record<string, number> = { [FILE_A]: 10 };
    const store = createStore(tokens);

    const { getByTestId } = render(
      <>
        <DirectoryMetadataCell compositeKey={DIRECTORY_KEY} store={store} />
        <FileMetadataCell compositeKey={FILE_A} store={store} />
        <FileMetadataCell compositeKey={FILE_B} store={store} />
      </>
    );

    expect(getByTestId(DIRECTORY_KEY).textContent).toBe('pending-metadata');

    tokens[FILE_B] = 5;
    act(() => {
      store.invalidate([FILE_B]);
    });

    expect(getByTestId(DIRECTORY_KEY).textContent).toBe('15');
    expect(renderCounts.get(DIRECTORY_KEY)).toBe(2);
    expect(renderCounts.get(FILE_B)).toBe(2);
    // The sibling never changed, so its cell must not have been disturbed.
    expect(renderCounts.get(FILE_A)).toBe(1);
  });

  it('never notifies a cell that has unmounted', () => {
    renderCounts.clear();
    const tokens: Record<string, number> = {};
    const store = createStore(tokens);
    const listener = vi.fn();

    const { unmount } = render(<FileMetadataCell compositeKey={FILE_A} store={store} />);
    unmount();
    store.subscribe(FILE_B, listener);
    store.getSnapshot(FILE_B);

    tokens[FILE_A] = 3;
    expect(() => store.invalidate([FILE_A])).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });
});
