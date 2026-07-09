import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openFileInTab = vi.fn();
vi.mock('@brainstrike/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...actual,
    CodeSurface: () => <div data-testid="file-code-surface" />,
    useIdeFileEditor: () => ({ openFileInTab, registerOpenFileInTab: vi.fn() }),
  };
});
vi.mock('@brainstrike/ui/markdown-surface', () => ({
  MarkdownSurface: ({ value }: { value: string }) => (
    <div data-testid="markdown-surface">{value}</div>
  ),
}));

import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { MarkdownPreviewCapabilitiesProvider } from '../../contexts/markdown-preview-capabilities';
import { useEditorViewStateStore } from '../../stores/editor-view-state-store';
import { FileTabBodyForTesting as FileTabBody } from '../workspace-tab-host';

const MD_KEY = encodeFileSelection('folder-1', '/root/docs/readme.md');
const TS_KEY = encodeFileSelection('folder-1', '/root/src/main.ts');

const capabilities = {
  openExternalLink: vi.fn().mockResolvedValue({ ok: true }),
  resolveImageSrc: vi.fn().mockResolvedValue('blob:x'),
};

function renderBody(compositeKey: string, content = '# Hello') {
  const path = compositeKey.split(':').slice(2).join(':');
  return render(
    <MarkdownPreviewCapabilitiesProvider capabilities={capabilities}>
      <FileTabBody
        content={content}
        isLoading={false}
        isRestoring={false}
        status={undefined}
        tab={{ compositeKey, content: null, id: compositeKey, isLoading: false, path }}
      />
    </MarkdownPreviewCapabilitiesProvider>
  );
}

describe('FileTabBody markdown integration', () => {
  beforeEach(() => {
    useEditorViewStateStore.getState().clear();
    vi.clearAllMocks();
  });

  it('renders the header for every file tab; toggle only on markdown', () => {
    const { unmount } = renderBody(TS_KEY, 'const x = 1;');
    expect(screen.getByText('main.ts')).toBeInTheDocument();
    expect(screen.queryByTestId('file-tab-mode-toggle')).not.toBeInTheDocument();
    unmount();
    renderBody(MD_KEY);
    expect(screen.getByTestId('file-tab-mode-toggle')).toBeInTheDocument();
  });

  it('defaults markdown tabs to preview', async () => {
    renderBody(MD_KEY);
    await waitFor(() => {
      expect(screen.getByTestId('markdown-surface')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('file-code-surface')).not.toBeInTheDocument();
  });

  it('honors a stored source mode', () => {
    useEditorViewStateStore.getState().setMode(MD_KEY, 'source');
    renderBody(MD_KEY);
    expect(screen.queryByTestId('markdown-surface')).not.toBeInTheDocument();
  });

  it('forces source transiently when a one-shot target exists, without writing the store', () => {
    useEditorViewStateStore.getState().setTarget(MD_KEY, { line: 12 });
    renderBody(MD_KEY);
    expect(screen.queryByTestId('markdown-surface')).not.toBeInTheDocument();
    expect(useEditorViewStateStore.getState().getMode(MD_KEY)).toBeUndefined();
  });

  it('toggle writes the store and switches surfaces', async () => {
    renderBody(MD_KEY);
    await waitFor(() => {
      expect(screen.getByTestId('markdown-surface')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /source/i }));
    expect(useEditorViewStateStore.getState().getMode(MD_KEY)).toBe('source');
    expect(screen.queryByTestId('markdown-surface')).not.toBeInTheDocument();
  });
});
