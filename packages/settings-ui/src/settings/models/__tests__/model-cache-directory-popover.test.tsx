import '@testing-library/jest-dom/vitest';
import {
  __resetModelRegistryStoreForTests,
  useModelRegistryStore,
} from '@brainstrike/app-state/stores/model-registry-store';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installCatalogDomStubs } from './catalog-dom-harness';

const toast = vi.fn();

vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  useToast: () => ({ toast }),
}));
vi.mock('@brainstrike/db/react', () => ({ usePGliteDatabase: () => null }));

import { ModelCacheDirectoryPopover } from '../model-cache-directory-popover';

describe('ModelCacheDirectoryPopover', () => {
  beforeEach(() => {
    installCatalogDomStubs({ width: null });
    toast.mockReset();
    __resetModelRegistryStoreForTests();
  });

  it('shows the current cache directory on the trigger', () => {
    render(<ModelCacheDirectoryPopover />);
    expect(screen.getByTestId('model-cache-dir-trigger')).toHaveTextContent(
      'Local cacheSystem default'
    );
    act(() => {
      useModelRegistryStore.setState({ modelCacheDir: '/models' });
    });
    expect(screen.getByTestId('model-cache-dir-trigger')).toHaveTextContent('Local cache/models');
  });

  it('edits the directory from the popover', async () => {
    render(<ModelCacheDirectoryPopover />);
    await userEvent.click(screen.getByTestId('model-cache-dir-trigger'));
    await userEvent.type(await screen.findByTestId('model-cache-dir-input'), '/data');
    expect(useModelRegistryStore.getState().modelCacheDir).toBe('/data');
  });

  it('reports that directory selection is unavailable without the desktop bridge', async () => {
    render(<ModelCacheDirectoryPopover />);
    await userEvent.click(screen.getByTestId('model-cache-dir-trigger'));
    await userEvent.click(await screen.findByTestId('model-cache-dir-select'));
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Directory selection unavailable', variant: 'destructive' })
    );
  });
});
