import type { IFileNode } from '@brainstrike/types';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceFilterFn } from '../use-workspace-filter-fn';

const mocks = vi.hoisted(() => ({
  state: {
    includeFilters: ['*.ts', '*.tsx'],
    excludeFilters: ['node_modules'],
    useRegex: false,
  },
  applyFileFilters: vi.fn(),
}));

vi.mock('@brainstrike/hooks', () => ({
  useEventCallback: <TArgs extends unknown[], TResult>(callback: (...args: TArgs) => TResult) =>
    callback,
  useFileFilters: () => ({
    applyFileFilters: mocks.applyFileFilters,
  }),
}));

vi.mock('../../shell/file-explorer-provider', () => ({
  useFileExplorerStoreContext: () => (selector: (state: typeof mocks.state) => unknown) =>
    selector(mocks.state),
  useFileExplorerStoreSelector: (selector: (state: typeof mocks.state) => unknown) =>
    selector(mocks.state),
}));

describe('useWorkspaceFilterFn', () => {
  beforeEach(() => {
    mocks.state.includeFilters = ['*.ts', '*.tsx'];
    mocks.state.excludeFilters = ['node_modules'];
    mocks.state.useRegex = false;
    mocks.applyFileFilters.mockReset();
  });

  it('applies workspace include/exclude/regex options to the provided tree', () => {
    const tree = [{ id: '1' }] as unknown as IFileNode[];
    const filtered = [{ id: '2' }] as unknown as IFileNode[];
    mocks.applyFileFilters.mockReturnValue(filtered);

    const { result, rerender } = renderHook(() => useWorkspaceFilterFn());
    const firstFn = result.current;

    expect(result.current(tree)).toBe(filtered);
    expect(mocks.applyFileFilters).toHaveBeenCalledWith(
      tree,
      ['*.ts', '*.tsx'],
      ['node_modules'],
      false
    );

    rerender();
    expect(result.current).toBe(firstFn);

    mocks.state.useRegex = true;
    rerender();

    expect(result.current).not.toBe(firstFn);
    result.current(tree);
    expect(mocks.applyFileFilters).toHaveBeenLastCalledWith(
      tree,
      ['*.ts', '*.tsx'],
      ['node_modules'],
      true
    );
  });
});
