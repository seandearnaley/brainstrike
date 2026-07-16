import { Button } from '@brainstrike/ui';
import { MarkdownSurface } from '@brainstrike/ui/markdown-surface';
import { createLogger } from '@brainstrike/utils';
import { Check, Copy, Eye, FileCode2, Loader2 } from 'lucide-react';
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

const logger = createLogger('NotesVaultViewer');

type ViewMode = 'preview' | 'source';

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
        {content.status === 'ready' ? <CopyButton content={content.content} /> : null}
        <Button
          aria-label={mode === 'preview' ? 'View source' : 'View preview'}
          aria-pressed={mode === 'source'}
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={() => setMode((current) => (current === 'preview' ? 'source' : 'preview'))}
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
      </header>
      {linkNotice ? (
        <p
          className="shrink-0 border-b bg-muted px-3 py-1 text-muted-foreground text-xs"
          role="status"
        >
          {linkNotice}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        {content.status === 'loading' ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 aria-label="Loading note" className="h-5 w-5 animate-spin" />
          </div>
        ) : null}
        {content.status === 'error' ? (
          <p className="p-4 text-destructive text-sm" role="alert">
            Could not read this note: {content.error}
          </p>
        ) : null}
        {content.status === 'ready' && mode === 'preview' ? (
          <MarkdownSurface
            ariaLabel={`Preview of ${note.name}`}
            onOpenLink={handleOpenLink}
            resolveImageSrc={resolveImageSrc}
            testId="note-viewer-preview"
            value={content.content}
          />
        ) : null}
        {content.status === 'ready' && mode === 'source' ? (
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
