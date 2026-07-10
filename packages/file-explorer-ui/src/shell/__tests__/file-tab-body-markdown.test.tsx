import { createTestActionRegistry } from '@brainstrike/context-actions';
import { ActionRegistryProvider } from '@brainstrike/ui';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface MockMarkdownSurfaceProps {
  readonly onContextMenuSelection?: (selection: { text: string | null }) => void;
  readonly onOpenLink: (href: string) => void;
  readonly onScrollTopChange?: (scrollTop: number) => void;
  readonly resolveImageSrc: (src: string) => Promise<string>;
  readonly value: string;
}

interface MockCodeSurfaceProps {
  readonly onContextMenuSelection?: (selection: {
    from: number;
    text: string | null;
    to: number;
  }) => void;
  readonly onScrollTopChange?: (scrollTop: number) => void;
}

const {
  codeSurfaceProps,
  contextSelections,
  markdownState,
  markdownSurfaceProps,
  openFileInTab,
  toastFn,
} = vi.hoisted(() => ({
  codeSurfaceProps: { current: null as MockCodeSurfaceProps | null },
  contextSelections: {
    code: null as string | null,
    markdown: null as string | null,
  },
  markdownState: { shouldThrow: false },
  markdownSurfaceProps: { current: null as MockMarkdownSurfaceProps | null },
  openFileInTab: vi.fn(),
  toastFn: vi.fn(),
}));

vi.mock('@brainstrike/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...actual,
    CodeSurface: (props: MockCodeSurfaceProps) => {
      codeSurfaceProps.current = props;
      return (
        // biome-ignore lint/a11y/noNoninteractiveElementInteractions: test double must reproduce CodeSurface's contextmenu callback timing
        // biome-ignore lint/a11y/noStaticElementInteractions: test double must reproduce CodeSurface's contextmenu callback timing
        <div
          data-testid="file-code-surface"
          onContextMenu={() =>
            props.onContextMenuSelection?.({
              from: 0,
              text: contextSelections.code,
              to: contextSelections.code?.length ?? 0,
            })
          }
        />
      );
    },
    useIdeFileEditor: () => ({ openFileInTab, registerOpenFileInTab: vi.fn() }),
    useToast: () => ({ toast: toastFn }),
  };
});
vi.mock('@brainstrike/ui/markdown-surface', () => ({
  MarkdownSurface: (props: MockMarkdownSurfaceProps) => {
    if (markdownState.shouldThrow) {
      throw new Error('markdown boom');
    }
    markdownSurfaceProps.current = props;
    return (
      // biome-ignore lint/a11y/noNoninteractiveElementInteractions: test double must reproduce MarkdownSurface's contextmenu callback timing
      // biome-ignore lint/a11y/noStaticElementInteractions: test double must reproduce MarkdownSurface's contextmenu callback timing
      <div
        data-testid="markdown-surface"
        onContextMenu={() => props.onContextMenuSelection?.({ text: contextSelections.markdown })}
      >
        {props.value}
      </div>
    );
  },
}));

import { decodeFileSelection, encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { fileEntryActions } from '../../context-actions/file-entry-actions';
import { MarkdownPreviewCapabilitiesProvider } from '../../contexts/markdown-preview-capabilities';
import { useEditorViewStateStore } from '../../stores/editor-view-state-store';
import { FileTabBodyForTesting as FileTabBody } from '../workspace-tab-host';

const MD_KEY = encodeFileSelection('folder-1', '/root/docs/readme.md');
const TS_KEY = encodeFileSelection('folder-1', '/root/src/main.ts');

const capabilities = {
  openExternalLink: vi.fn(),
  resolveImageSrc: vi.fn(),
};

function renderBody(compositeKey: string, content = '# Hello', withCapabilities = true) {
  const { path } = decodeFileSelection(compositeKey);
  const { registry, writtenTexts } = createTestActionRegistry({ actions: fileEntryActions });
  const body = (
    <FileTabBody
      content={content}
      isLoading={false}
      isRestoring={false}
      rootPath="/root"
      status={undefined}
      tab={{ compositeKey, content: null, id: compositeKey, isLoading: false, path }}
    />
  );
  const rendered = render(
    <ActionRegistryProvider registry={registry}>
      {withCapabilities ? (
        <MarkdownPreviewCapabilitiesProvider capabilities={capabilities}>
          {body}
        </MarkdownPreviewCapabilitiesProvider>
      ) : (
        body
      )}
    </ActionRegistryProvider>
  );
  return { ...rendered, writtenTexts };
}

async function renderPreview(withCapabilities = true) {
  renderBody(MD_KEY, '# Hello', withCapabilities);
  await waitFor(() => {
    expect(screen.getByTestId('markdown-surface')).toBeInTheDocument();
  });
}

/** Non-null accessor so a negative assertion (e.g. "openFileInTab NOT called")
 * can never false-pass against a surface that silently failed to render. */
function mdProps(): MockMarkdownSurfaceProps {
  const props = markdownSurfaceProps.current;
  if (!props) {
    throw new Error('MarkdownSurface did not render');
  }
  return props;
}

function codeProps(): MockCodeSurfaceProps {
  const props = codeSurfaceProps.current;
  if (!props) {
    throw new Error('CodeSurface did not render');
  }
  return props;
}

describe('FileTabBody markdown integration', () => {
  beforeEach(() => {
    useEditorViewStateStore.getState().clear();
    vi.clearAllMocks();
    markdownState.shouldThrow = false;
    markdownSurfaceProps.current = null;
    codeSurfaceProps.current = null;
    contextSelections.code = null;
    contextSelections.markdown = null;
    // clearAllMocks clears calls but not implementations — re-arm the defaults so a
    // per-test mockResolvedValue (e.g. {ok:false}) never leaks into the next test.
    capabilities.openExternalLink.mockResolvedValue({ ok: true });
    capabilities.resolveImageSrc.mockResolvedValue('blob:x');
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

  describe('context menu selection copy', () => {
    it('copies the CodeMirror event-time snapshot even if selection changes while the menu is open', async () => {
      useEditorViewStateStore.getState().setMode(TS_KEY, 'source');
      contextSelections.code = 'const x';
      const { writtenTexts } = renderBody(TS_KEY, 'const x = 1;');

      fireEvent.contextMenu(screen.getByTestId('file-code-surface'));
      const copyItem = await screen.findByRole('menuitem', { name: /copy\s+(ctrl|⌘)/i });
      contextSelections.code = 'changed later';
      fireEvent.click(copyItem);

      await waitFor(() => {
        expect(writtenTexts).toEqual(['const x']);
      });
    });

    it('copies an exact Markdown DOM selection snapshot', async () => {
      contextSelections.markdown = '  Hello\n';
      const { writtenTexts } = renderBody(MD_KEY, '# Hello');
      await screen.findByTestId('markdown-surface');

      fireEvent.contextMenu(screen.getByTestId('markdown-surface'));
      fireEvent.click(await screen.findByRole('menuitem', { name: /copy\s+(ctrl|⌘)/i }));

      await waitFor(() => {
        expect(writtenTexts).toEqual(['  Hello\n']);
      });
    });
  });

  describe('scroll persistence slots', () => {
    it('preview scroll writes to the preview slot, never the source slot', async () => {
      await renderPreview();
      act(() => {
        mdProps().onScrollTopChange?.(123);
      });
      const store = useEditorViewStateStore.getState();
      expect(store.getScrollTop(`preview:${MD_KEY}`)).toBe(123);
      expect(store.getScrollTop(MD_KEY)).toBe(0);
    });

    it('source scroll writes to the plain compositeKey slot, never the preview slot', () => {
      useEditorViewStateStore.getState().setMode(MD_KEY, 'source');
      renderBody(MD_KEY);
      expect(screen.getByTestId('file-code-surface')).toBeInTheDocument();
      act(() => {
        codeProps().onScrollTopChange?.(77);
      });
      const store = useEditorViewStateStore.getState();
      expect(store.getScrollTop(MD_KEY)).toBe(77);
      expect(store.getScrollTop(`preview:${MD_KEY}`)).toBe(0);
    });
  });

  describe('error boundary', () => {
    it('catches a preview crash and "Open in source" switches to the code surface', async () => {
      // React logs boundary-caught render errors; silence the expected noise here only.
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {
        /* expected: boundary-caught render error */
      });
      try {
        markdownState.shouldThrow = true;
        renderBody(MD_KEY);
        await waitFor(() => {
          expect(screen.getByText('Preview failed to render')).toBeInTheDocument();
        });
        fireEvent.click(screen.getByRole('button', { name: /open in source/i }));
        expect(screen.getByTestId('file-code-surface')).toBeInTheDocument();
        expect(useEditorViewStateStore.getState().getMode(MD_KEY)).toBe('source');
      } finally {
        consoleError.mockRestore();
      }
    });
  });

  describe('image resolution', () => {
    it('blocks remote image URLs without touching the capability (visible via placeholder)', async () => {
      await renderPreview();
      // file-explorer-ui AGENTS.md: preview content must not load external
      // resources — remote srcs reject (MarkdownImage renders its placeholder)
      // and never reach the platform capability or the network.
      await expect(mdProps().resolveImageSrc('https://tracker.example/x.png')).rejects.toThrow(
        /remote images are blocked/i
      );
      await expect(mdProps().resolveImageSrc('http://localhost:9999/x.png')).rejects.toThrow(
        /remote images are blocked/i
      );
      expect(capabilities.resolveImageSrc).not.toHaveBeenCalled();
    });

    it('still resolves workspace-relative images through the capability', async () => {
      capabilities.resolveImageSrc.mockResolvedValue('blob:ok');
      await renderPreview();
      await expect(mdProps().resolveImageSrc('./img/a.png')).resolves.toBe('blob:ok');
      expect(capabilities.resolveImageSrc).toHaveBeenCalledWith('/root/docs/img/a.png');
    });
  });

  describe('link routing', () => {
    it('opens relative links via openFileInTab resolved against the current file', async () => {
      await renderPreview();
      act(() => {
        mdProps().onOpenLink('./other.md');
      });
      expect(openFileInTab).toHaveBeenCalledWith(
        encodeFileSelection('folder-1', '/root/docs/other.md')
      );
      expect(toastFn).not.toHaveBeenCalled();
    });

    it('toasts destructively when a relative link escapes the workspace', async () => {
      await renderPreview();
      act(() => {
        mdProps().onOpenLink('../../../etc/x.md');
      });
      expect(openFileInTab).not.toHaveBeenCalled();
      expect(toastFn).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Link is outside the workspace', variant: 'destructive' })
      );
    });

    it('toasts destructively when the external opener reports {ok:false}', async () => {
      capabilities.openExternalLink.mockResolvedValue({ error: 'x', ok: false });
      await renderPreview();
      act(() => {
        mdProps().onOpenLink('https://example.test/page');
      });
      await waitFor(() => {
        expect(toastFn).toHaveBeenCalledWith(
          expect.objectContaining({
            description: 'x',
            title: 'Could not open link',
            variant: 'destructive',
          })
        );
      });
      expect(openFileInTab).not.toHaveBeenCalled();
    });

    it('toasts destructively for external links when capabilities are absent', async () => {
      await renderPreview(false);
      act(() => {
        mdProps().onOpenLink('https://example.test/page');
      });
      expect(toastFn).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'External links unavailable', variant: 'destructive' })
      );
      expect(capabilities.openExternalLink).not.toHaveBeenCalled();
      expect(openFileInTab).not.toHaveBeenCalled();
    });

    it('rejects protocol-relative links instead of treating them as relative paths', async () => {
      await renderPreview();
      act(() => {
        mdProps().onOpenLink('//example.test/page');
      });
      expect(openFileInTab).not.toHaveBeenCalled();
      expect(capabilities.openExternalLink).not.toHaveBeenCalled();
      expect(toastFn).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Unsupported link type', variant: 'destructive' })
      );
    });

    it('rejects non-http(s)/mailto schemes instead of treating them as relative paths', async () => {
      await renderPreview();
      act(() => {
        mdProps().onOpenLink('javascript:alert(1)');
      });
      expect(openFileInTab).not.toHaveBeenCalled();
      expect(capabilities.openExternalLink).not.toHaveBeenCalled();
      expect(toastFn).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Unsupported link type', variant: 'destructive' })
      );
    });
  });
});
