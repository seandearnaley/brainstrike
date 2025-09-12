import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RightPanel } from '../right-panel';

vi.mock('@brainstrike/db', () => ({
  useFileRecordRepository: () => null,
  usePGliteDatabase: () => null,
  useFileChunkRepository: () => null,
  useClearAllData: () => null,
  useDbProviderError: () => null,
  useVectorEnabled: () => false,
  useFactoryReset: () => null,
}));

vi.mock('@brainstrike/embeddings', async () => {
  const actual = await vi.importActual<object>('@brainstrike/embeddings');
  return {
    ...(actual as object),
    TransformersBackend: { getBestDevice: () => 'cpu' },
  };
});

vi.mock('@brainstrike/ui', async () => {
  const actual = await vi.importActual('@brainstrike/ui');
  return {
    ...actual,
    useToast: () => ({ toast: vi.fn() }),
  };
});

vi.mock('../file-import-service', () => ({
  useFileImportService: () => ({ isImporting: false, progress: null }),
}));

vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({ fileSystemAdapter: null, databaseAdapter: null }),
}));

vi.mock('@brainstrike/file-explorer-ui', () => ({
  useFileExplorer: () => ({ fileContents: {}, fileTree: [] }),
  useSelectionManager: () => ({ selectedFilePaths: new Set() }),
}));

describe('RightPanel controls', () => {
  it('updates search filters and DB logs controls', async () => {
    const user = userEvent.setup();
    render(<RightPanel />);

    // Switch to Search tab
    await user.click(screen.getByRole('tab', { name: /search/i }));

    const query = screen.getByLabelText('Query');
    await user.clear(query);
    await user.type(query, 'hello world');

    // Toggle flags
    const regex = screen.getByLabelText('Regex');
    const caseBox = screen.getByLabelText('Case');
    const whole = screen.getByLabelText('Whole word');
    await user.click(regex);
    await user.click(caseBox);
    await user.click(whole);

    // Switch to Database tab and select Logs subtab
    await user.click(screen.getByRole('tab', { name: /db/i }));
    const viewRow = screen.getByText('View').closest('div');
    const select = within(viewRow as HTMLElement).getByRole('combobox', { name: 'DB subtab' });
    await user.selectOptions(select, 'logs');

    // Fill DB logs controls
    await user.type(screen.getByLabelText('Filter'), 'embeddings');
    await user.clear(screen.getByLabelText('Sort By'));
    await user.type(screen.getByLabelText('Sort By'), 'timestamp');
    const dir = screen.getByLabelText('Direction');
    await user.selectOptions(dir, 'desc');
    await user.clear(screen.getByLabelText('Page'));
    await user.type(screen.getByLabelText('Page'), '2');
    await user.clear(screen.getByLabelText('Page Size'));
    await user.type(screen.getByLabelText('Page Size'), '25');

    // Round-trip back to Search to ensure values stuck in store
    await user.click(screen.getByRole('tab', { name: /search/i }));
    expect(screen.getByLabelText('Query')).toHaveValue('hello world');
    expect(screen.getByLabelText('Regex')).toBeChecked();
    expect(screen.getByLabelText('Case')).toBeChecked();
    expect(screen.getByLabelText('Whole word')).toBeChecked();
  });
});
