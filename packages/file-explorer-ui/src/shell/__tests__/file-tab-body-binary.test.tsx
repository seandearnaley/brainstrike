import { type ActionServices, createTestActionRegistry } from '@brainstrike/context-actions';
import { encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { buildInaccessibleContent } from '@brainstrike/file-explorer-hooks';
import { BINARY_CONTENT_MESSAGE } from '@brainstrike/types';
import { ActionRegistryProvider } from '@brainstrike/ui';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubMatchMedia } from '../../__tests__/setup/stub-match-media';
import { fileEntryActions } from '../../context-actions/file-entry-actions';
import { useEditorViewStateStore } from '../../stores/editor-view-state-store';
import { FileTabBodyForTesting as FileTabBody } from '../file-tab-body';

const { openFileInTab, toastFn } = vi.hoisted(() => ({
  openFileInTab: vi.fn(),
  toastFn: vi.fn(),
}));

vi.mock('@brainstrike/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...actual,
    CodeSurface: () => <div data-testid="file-code-surface" />,
    useIdeFileEditor: () => ({ openFileInTab, registerOpenFileInTab: vi.fn() }),
    useToast: () => ({ toast: toastFn }),
  };
});

// The pane is open by default (BST-1318) and the real one requires a
// FileSystemProvider — stub it; pane behavior is covered by the pane tests.
vi.mock('../file-tab-explorer-pane', () => ({
  FileTabExplorerPane: () => <div data-testid="pane-spy" />,
}));

const BINARY_KEY = encodeFileSelection('folder-1', '/root/assets/logo.png');
const RELATIVE_BINARY_KEY = encodeFileSelection('folder-1', 'assets/logo.png');

interface RenderOptions {
  readonly capabilities?: readonly ('clipboard' | 'fs.reveal' | 'fs.openPath')[];
  readonly compositeKey?: string;
  /** `null` renders a tab whose content has not arrived. */
  readonly content?: string | null;
  readonly rootPath?: string | null;
  readonly rootState?: 'connected' | 'connecting' | 'disconnected';
  readonly services?: ActionServices;
}

function renderBinaryBody({
  capabilities,
  compositeKey = BINARY_KEY,
  content = BINARY_CONTENT_MESSAGE,
  rootPath = '/root',
  rootState,
  services,
}: RenderOptions = {}) {
  const { registry, writtenTexts } = createTestActionRegistry({
    actions: [...fileEntryActions],
    ...(capabilities ? { capabilities } : {}),
    ...(services ? { services } : {}),
  });
  const rendered = render(
    <ActionRegistryProvider registry={registry}>
      <FileTabBody
        content={content ?? undefined}
        isLoading={false}
        isRestoring={false}
        onRetryContent={vi.fn()}
        rootPath={rootPath}
        {...(rootState ? { rootState } : {})}
        status={undefined}
        tab={{
          compositeKey,
          content: null,
          id: compositeKey,
          isLoading: false,
          path: 'assets/logo.png',
        }}
      />
    </ActionRegistryProvider>
  );
  return { ...rendered, writtenTexts };
}

function createPlatformFsServices() {
  const openPath = vi.fn().mockResolvedValue({ ok: true });
  const showItemInFolder = vi.fn().mockResolvedValue({ ok: true });
  const writtenTexts: string[] = [];
  const services: ActionServices = {
    clipboard: {
      writeText: (text: string) => {
        writtenTexts.push(text);
        return Promise.resolve({ ok: true as const });
      },
    },
    platformFs: { openPath, showItemInFolder },
  };
  return { openPath, services, showItemInFolder, writtenTexts };
}

describe('FileTabBody binary file preview', () => {
  beforeEach(() => {
    stubMatchMedia();
    useEditorViewStateStore.getState().clear();
    vi.clearAllMocks();
  });

  it('renders the binary preview screen instead of a code surface', () => {
    renderBinaryBody();
    const preview = screen.getByTestId('binary-file-preview');
    expect(within(preview).getByText('logo.png')).toBeInTheDocument();
    expect(within(preview).getByText('PNG')).toBeInTheDocument();
    expect(screen.queryByTestId('file-code-surface')).not.toBeInTheDocument();
    // The raw sentinel string must never be dumped as if it were file text.
    expect(within(preview).queryByText(BINARY_CONTENT_MESSAGE)).not.toBeInTheDocument();
  });

  it('titles a Windows file by its name, in its preview and in its header', () => {
    const binary = encodeFileSelection('folder-1', 'C:\\root\\assets\\logo.png');
    renderBinaryBody({ compositeKey: binary, rootPath: 'C:\\root' });
    expect(within(screen.getByTestId('binary-file-preview')).getByText('logo.png')).toBeVisible();
    cleanup();

    const text = encodeFileSelection('folder-1', 'C:\\root\\src\\index.ts');
    renderBinaryBody({ compositeKey: text, content: 'export {};', rootPath: 'C:\\root' });
    expect(screen.getByRole('button', { name: 'Copy index.ts' })).toBeInTheDocument();
  });

  it('does not hijack contents that merely mention binary files', () => {
    renderBinaryBody({ content: `${BINARY_CONTENT_MESSAGE} — said the log file` });
    expect(screen.queryByTestId('binary-file-preview')).not.toBeInTheDocument();
    expect(screen.getByTestId('file-code-surface')).toBeInTheDocument();
  });

  it('says the folder is connecting while it restores, then that it is not connected', () => {
    renderBinaryBody({ content: null, rootState: 'connecting' });
    expect(screen.getByRole('status')).toHaveTextContent('Connecting folder…');

    cleanup();
    renderBinaryBody({ content: null, rootState: 'disconnected' });
    expect(screen.getByText('Folder not connected')).toBeInTheDocument();
    expect(screen.queryByText('Connecting folder…')).not.toBeInTheDocument();
  });

  it('renders a canonical inaccessible worker result outside the code surface', () => {
    const inaccessibleContent = buildInaccessibleContent('File disappeared during refresh');

    renderBinaryBody({ content: inaccessibleContent });

    expect(screen.getByText('File disappeared during refresh')).toBeInTheDocument();
    expect(screen.queryByTestId('binary-file-preview')).not.toBeInTheDocument();
    expect(screen.queryByTestId('file-code-surface')).not.toBeInTheDocument();
  });

  it('reveals the file in the OS file manager with a platform-specific label', async () => {
    const platformSpy = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    try {
      const { services, showItemInFolder } = createPlatformFsServices();
      renderBinaryBody({ services });
      const reveal = screen.getByRole('button', { name: 'Reveal in Finder' });
      fireEvent.click(reveal);
      await waitFor(() => {
        expect(showItemInFolder).toHaveBeenCalledWith('/root/assets/logo.png');
      });
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('labels the reveal action for non-mac platforms', () => {
    const platformSpy = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    try {
      const { services } = createPlatformFsServices();
      renderBinaryBody({ services });
      expect(screen.getByRole('button', { name: 'Reveal in File Explorer' })).toBeInTheDocument();
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('opens the file in the default app', async () => {
    const { openPath, services } = createPlatformFsServices();
    renderBinaryBody({ services });
    fireEvent.click(screen.getByRole('button', { name: 'Open in Default App' }));
    await waitFor(() => {
      expect(openPath).toHaveBeenCalledWith('/root/assets/logo.png');
    });
  });

  it('copies the full path and confirms with a toast', async () => {
    const { services, writtenTexts } = createPlatformFsServices();
    renderBinaryBody({ services });
    fireEvent.click(screen.getByRole('button', { name: 'Copy Full Path' }));
    await waitFor(() => {
      expect(writtenTexts).toEqual(['/root/assets/logo.png']);
    });
    expect(toastFn).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Full path copied' })
    );
  });

  it('surfaces a failed action as a destructive toast', async () => {
    const { services, showItemInFolder } = createPlatformFsServices();
    showItemInFolder.mockResolvedValue({ error: 'Finder unavailable', ok: false });
    renderBinaryBody({ services });
    fireEvent.click(screen.getByRole('button', { name: /Reveal in/u }));
    await waitFor(() => {
      expect(toastFn).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'Finder unavailable',
          title: 'Action failed',
          variant: 'destructive',
        })
      );
    });
  });

  it('hides desktop-only actions when fs capabilities are absent (web)', () => {
    renderBinaryBody({ capabilities: ['clipboard'] });
    expect(screen.queryByRole('button', { name: /Reveal in/u })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in Default App' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy Full Path' })).toBeInTheDocument();
  });

  it('falls back to Copy Relative Path when no absolute path exists', async () => {
    const { writtenTexts } = renderBinaryBody({
      compositeKey: RELATIVE_BINARY_KEY,
      rootPath: null,
    });
    expect(screen.queryByRole('button', { name: /Reveal in/u })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in Default App' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy Full Path' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy Relative Path' }));
    await waitFor(() => {
      expect(writtenTexts).toEqual(['assets/logo.png']);
    });
  });
});
