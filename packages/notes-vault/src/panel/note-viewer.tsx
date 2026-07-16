import { Button, CodeSurface } from '@brainstrike/ui';
import { MarkdownSurface } from '@brainstrike/ui/markdown-surface';
import { createLogger } from '@brainstrike/utils';
import { Check, Copy, Eye, FileCode2, Loader2, Pencil } from 'lucide-react';
import type * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { findVaultNote, noteIdForSegments, resolveRelativeNoteSegments } from '../core/links';
import { getFileHandleAt } from '../core/resolve';
import type { VaultRootState } from '../core/rows';
import type { VaultNoteNode } from '../core/types';
import type { NotesVaultStore } from '../store/notes-vault-store';
import { noteDisplayName } from './note-display-name';
import { useNoteContent } from './use-note-content';
import { type NoteEditorApi, type NoteSaveState, useNoteEditor } from './use-note-editor';

const logger = createLogger('NotesVaultViewer');

type ViewMode = 'preview' | 'source';

const SAVE_STATE_LABELS: Record<NoteSaveState, string | null> = {
  dirty: 'Unsaved changes',
  error: null, // the full error message renders instead
  idle: null,
  saved: 'Saved',
  saving: 'Saving…',
};

function rootForNote(roots: readonly VaultRootState[], note: VaultNoteNode): VaultRootState | null {
  return roots.find((root) => root.rootId === note.rootId) ?? null;
}

function CopyButton({ content }: { content: string }): React.ReactNode {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      setFailed(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      logger.error('Copying note content failed', { error });
      setFailed(true);
    }
  }, [content]);

  return (
    <span className="flex items-center gap-1">
      {failed ? <span className="text-destructive text-xs">Copy failed</span> : null}
      <Button
        aria-label="Copy note content"
        className="h-7 gap-1.5 px-2 text-xs"
        onClick={() => {
          void handleCopy();
        }}
        size="sm"
        variant="ghost"
      >
        {copied ? (
          <Check aria-hidden="true" className="h-3.5 w-3.5 text-green-600" />
        ) : (
          <Copy aria-hidden="true" className="h-3.5 w-3.5" />
        )}
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </span>
  );
}

function HeaderActions({
  editor,
  contentReady,
  copyContent,
  mode,
  onToggleMode,
}: {
  editor: NoteEditorApi;
  contentReady: boolean;
  copyContent: string;
  mode: ViewMode;
  onToggleMode: () => void;
}): React.ReactNode {
  return (
    <>
      {editor.editing && SAVE_STATE_LABELS[editor.saveState] ? (
        <span
          className={`shrink-0 text-xs ${editor.saveState === 'dirty' ? 'text-muted-foreground' : 'text-muted-foreground/80'}`}
          data-testid="note-save-state"
          role="status"
        >
          {SAVE_STATE_LABELS[editor.saveState]}
        </span>
      ) : null}
      {contentReady ? <CopyButton content={copyContent} /> : null}
      {editor.editing ? (
        <Button
          aria-label="Done editing"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={() => {
            void editor.endEdit();
          }}
          size="sm"
          variant="outline"
        >
          <Check aria-hidden="true" className="h-3.5 w-3.5" />
          Done
        </Button>
      ) : (
        <>
          {contentReady ? (
            <Button
              aria-label="Edit note"
              className="h-7 gap-1.5 px-2 text-xs"
              onClick={editor.beginEdit}
              size="sm"
              variant="ghost"
            >
              <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
              Edit
            </Button>
          ) : null}
          <Button
            aria-label={mode === 'preview' ? 'View source' : 'View preview'}
            aria-pressed={mode === 'source'}
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={onToggleMode}
            size="sm"
            variant="ghost"
          >
            {mode === 'preview' ? (
              <FileCode2 aria-hidden="true" className="h-3.5 w-3.5" />
            ) : (
              <Eye aria-hidden="true" className="h-3.5 w-3.5" />
            )}
            {mode === 'preview' ? 'Source' : 'Preview'}
          </Button>
        </>
      )}
    </>
  );
}

/** Transient notice / alert rows under the header. */
function NoticeRow({
  message,
  tone,
}: {
  message: string;
  tone: 'alert' | 'status';
}): React.ReactNode {
  return (
    <p
      className={`shrink-0 border-b px-3 py-1 text-xs ${
        tone === 'alert' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'
      }`}
      role={tone}
    >
      {message}
    </p>
  );
}

export interface NoteViewerProps {
  store: NotesVaultStore;
}

/**
 * The vault's first-class markdown viewer. Preview renders through the shared
 * MarkdownSurface (GFM + math + mermaid + shiki, raw HTML inert); source mode
 * shows the raw markdown. Relative .md links navigate inside the vault;
 * relative images resolve through the vault handle into object URLs (revoked
 * on note change — never leaked); external links open in a new tab.
 */
export function NoteViewer({ store }: NoteViewerProps): React.ReactNode {
  const roots = useStore(store, (state) => state.roots);
  const selectedNoteId = useStore(store, (state) => state.selectedNoteId);
  const selectNote = useStore(store, (state) => state.selectNote);
  const [mode, setMode] = useState<ViewMode>('preview');
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const linkNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showLinkNotice = useCallback((message: string) => {
    setLinkNotice(message);
    if (linkNoticeTimerRef.current) {
      clearTimeout(linkNoticeTimerRef.current);
    }
    linkNoticeTimerRef.current = setTimeout(() => setLinkNotice(null), 4000);
  }, []);
  // biome-ignore lint/plugin: unmount-only timer cleanup, not state-as-event-handler
  useEffect(
    () => () => {
      if (linkNoticeTimerRef.current) {
        clearTimeout(linkNoticeTimerRef.current);
      }
    },
    []
  );

  const note = selectedNoteId ? findVaultNote(roots, selectedNoteId) : null;
  const content = useNoteContent(note);
  const refreshRoot = useStore(store, (state) => state.refreshRoot);
  const editRequestNoteId = useStore(store, (state) => state.editRequestNoteId);
  const clearEditRequest = useStore(store, (state) => state.clearEditRequest);

  const handleSaved = useCallback(() => {
    if (note) {
      // Keeps mtime sorting + the tree fresh on backends without a watcher.
      void refreshRoot(note.rootId);
    }
  }, [note, refreshRoot]);
  const reportGlobalError = useStore(store, (state) => state.reportGlobalError);
  const handleDetachedSaveError = useCallback(
    (noteName: string, message: string) => {
      reportGlobalError(`Unsaved changes to "${noteName}" could not be saved: ${message}`);
    },
    [reportGlobalError]
  );
  const editor = useNoteEditor({
    diskContent: content.status === 'ready' ? content.content : null,
    note,
    onDetachedSaveError: handleDetachedSaveError,
    onSaved: handleSaved,
  });
  const { beginEdit } = editor;

  // Consume the one-shot edit request (armed by New Note) once content is ready.
  // biome-ignore lint/plugin: one-shot cross-component handshake (store-armed edit request), not derived state
  useEffect(() => {
    if (editRequestNoteId && note && editRequestNoteId === note.id && content.status === 'ready') {
      beginEdit();
      clearEditRequest();
    }
  }, [editRequestNoteId, note, content.status, beginEdit, clearEditRequest]);

  const toggleMode = useCallback(
    () => setMode((current) => (current === 'preview' ? 'source' : 'preview')),
    []
  );

  const handleEditorKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void editor.save();
      }
    },
    [editor]
  );

  const objectUrlsRef = useRef<string[]>([]);
  const revokeObjectUrls = useCallback(() => {
    for (const url of objectUrlsRef.current) {
      URL.revokeObjectURL(url);
    }
    objectUrlsRef.current = [];
  }, []);
  useEffect(() => revokeObjectUrls, [revokeObjectUrls]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revoke stale image URLs whenever the viewed note changes.
  useEffect(() => {
    revokeObjectUrls();
  }, [selectedNoteId, revokeObjectUrls]);

  const resolveImageSrc = useCallback(
    async (src: string): Promise<string> => {
      if (!note) {
        throw new Error('No note selected');
      }
      // Inline data: URIs are self-contained and safe — same contract as the
      // workspace file-tab markdown preview. Remote http(s) images stay
      // blocked (they reject below as "outside the vault").
      if (/^data:/i.test(src)) {
        return src;
      }
      const segments = resolveRelativeNoteSegments(note.pathSegments, src);
      const root = rootForNote(roots, note);
      if (!(segments && root)) {
        throw new Error(`Image is outside the vault: ${src}`);
      }
      const handle = await getFileHandleAt(root.handle, segments);
      const file = await handle.getFile();
      const url = URL.createObjectURL(file);
      objectUrlsRef.current.push(url);
      return url;
    },
    [note, roots]
  );

  const handleOpenLink = useCallback(
    (href: string) => {
      if (note) {
        const segments = resolveRelativeNoteSegments(note.pathSegments, href);
        if (segments) {
          const targetId = noteIdForSegments(note.rootId, segments);
          if (findVaultNote(roots, targetId)) {
            selectNote(targetId);
            return;
          }
        }
      }
      if (/^https?:/i.test(href)) {
        window.open(href, '_blank', 'noopener,noreferrer');
        return;
      }
      // A clicked link must never be a silent no-op.
      logger.warn('Unresolvable note link', { href });
      showLinkNotice(`Couldn't find "${href}" in this vault.`);
    },
    [note, roots, selectNote, showLinkNotice]
  );

  if (!note) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Select a note to read it
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="note-viewer">
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold text-sm">{noteDisplayName(note.name)}</h2>
          <p className="truncate text-muted-foreground text-xs">{note.pathSegments.join(' / ')}</p>
        </div>
        <HeaderActions
          contentReady={content.status === 'ready'}
          copyContent={
            editor.editing ? editor.draft : content.status === 'ready' ? content.content : ''
          }
          editor={editor}
          mode={mode}
          onToggleMode={toggleMode}
        />
      </header>
      {editor.error ? <NoticeRow message={editor.error} tone="alert" /> : null}
      {editor.externallyChanged ? (
        <NoticeRow
          message="This note changed on disk while you were editing — your unsaved version is shown; saving will overwrite the external change."
          tone="status"
        />
      ) : null}
      {linkNotice ? <NoticeRow message={linkNotice} tone="status" /> : null}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: ⌘S save shortcut for the editor subtree; the Done button is the accessible path. */}
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: see above. */}
      <div className="min-h-0 flex-1 overflow-hidden" onKeyDown={handleEditorKeyDown}>
        {editor.editing ? (
          <CodeSurface
            ariaLabel={`Edit ${note.name}`}
            editable
            language="markdown"
            lineWrapping
            onChange={editor.updateDraft}
            path={note.name}
            testId="note-editor"
            value={editor.draft}
          />
        ) : null}
        {!editor.editing && content.status === 'loading' ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 aria-label="Loading note" className="h-5 w-5 animate-spin" />
          </div>
        ) : null}
        {!editor.editing && content.status === 'error' ? (
          <p className="p-4 text-destructive text-sm" role="alert">
            Could not read this note: {content.error}
          </p>
        ) : null}
        {!editor.editing && content.status === 'ready' && mode === 'preview' ? (
          <MarkdownSurface
            ariaLabel={`Preview of ${note.name}`}
            onOpenLink={handleOpenLink}
            resolveImageSrc={resolveImageSrc}
            testId="note-viewer-preview"
            value={content.content}
          />
        ) : null}
        {!editor.editing && content.status === 'ready' && mode === 'source' ? (
          <pre
            className="h-full overflow-auto whitespace-pre-wrap p-4 font-mono text-foreground/90 text-xs leading-relaxed"
            data-testid="note-viewer-source"
          >
            {content.content}
          </pre>
        ) : null}
      </div>
    </div>
  );
}
