import { useCallback, useRef } from 'react';
import type { ReleaseManifestState } from '../releases/use-release-manifest';
import {
  buildDownloadViewModel,
  type DownloadActionView,
  type DownloadPlatformView,
} from './download-view-model';
import { type DocumentScrollLock, lockDocumentScroll } from './modal-scroll-lock';

interface DownloadChooserProps {
  readonly manifestState: ReleaseManifestState;
  readonly onOpenFull?: (() => void) | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly presentation?: 'full' | 'terminal';
}

function FullDownloadActions({ platform }: { readonly platform: DownloadPlatformView }) {
  if (platform.actions.length === 0) {
    return <span className="platform-pending">Not published</span>;
  }
  return platform.actions.map((action) => (
    <a href={action.asset.url} key={action.asset.name} rel="noreferrer">
      <span>
        {action.label} <span aria-hidden="true">↓</span>
      </span>
      <small>{action.sizeLabel}</small>
      <code title={action.asset.digest}>{action.asset.digest}</code>
    </a>
  ));
}

function TerminalDownloadAction({
  action,
  actionCount,
  onOpenFull,
}: {
  readonly action: DownloadActionView | undefined;
  readonly actionCount: number;
  readonly onOpenFull: (() => void) | undefined;
}) {
  if (actionCount > 1 && onOpenFull) {
    return (
      <button
        onClick={(event) => {
          event.currentTarget.focus();
          onOpenFull();
        }}
        type="button"
      >
        {actionCount} builds <span aria-hidden="true">↗</span>
      </button>
    );
  }
  if (action) {
    return (
      <a aria-label={`Download ${action.label}`} href={action.asset.url} rel="noreferrer">
        Download <span aria-hidden="true">↓</span>
      </a>
    );
  }
  return <span className="platform-pending">Pending</span>;
}

export function DownloadChooser({
  manifestState,
  onOpenFull,
  onRetry,
  presentation = 'full',
}: DownloadChooserProps) {
  const view = buildDownloadViewModel(manifestState);
  const statusRole = view.status.kind === 'error' ? 'alert' : 'status';

  return (
    <section
      aria-busy={view.status.kind === 'loading'}
      aria-label="Brainstrike downloads"
      className={`download-chooser download-chooser-${presentation}`}
    >
      <div aria-atomic="true" aria-live="polite" className="download-status-line" role={statusRole}>
        <span
          aria-hidden="true"
          className={`status-dot ${view.status.kind === 'live' ? 'status-dot-live' : ''}`}
        />
        <span>{view.status.message}</span>
        {view.status.kind === 'error' && onRetry ? (
          <button className="manifest-retry" onClick={onRetry} type="button">
            Retry
          </button>
        ) : null}
      </div>

      <div className="platform-grid">
        {view.platforms.map((platform) => (
          <article className="platform-option" key={platform.platform}>
            <span aria-hidden="true" className="platform-glyph">
              {platform.glyph}
            </span>
            <div className="platform-copy">
              <h3>{platform.name}</h3>
              <p>{platform.summary}</p>
            </div>
            <div className="platform-action">
              {presentation === 'terminal' ? (
                <TerminalDownloadAction
                  action={platform.actions[0]}
                  actionCount={platform.actions.length}
                  onOpenFull={onOpenFull}
                />
              ) : (
                <FullDownloadActions platform={platform} />
              )}
            </div>
          </article>
        ))}
      </div>
      <p className="release-integrity-note">
        {view.releasesHubUrl ? (
          <>
            Direct links are verified against the signed release manifest.{' '}
            <a href={view.releasesHubUrl} rel="noreferrer" target="_blank">
              All release assets <span aria-hidden="true">↗</span>
            </a>
          </>
        ) : (
          'Direct links appear only after a public release manifest names a verified asset.'
        )}
      </p>
    </section>
  );
}

interface DownloadDialogProps extends DownloadChooserProps {
  readonly onClose: () => void;
  readonly open: boolean;
}

export function DownloadDialog({ manifestState, onClose, onRetry, open }: DownloadDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const scrollLockRef = useRef<DocumentScrollLock | null>(null);
  const showDialog = useCallback((dialog: HTMLDialogElement | null) => {
    if (!dialog) {
      scrollLockRef.current?.release();
      scrollLockRef.current = null;
      dialogRef.current = null;
      return;
    }
    if (dialog.open) {
      return;
    }
    dialogRef.current = dialog;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    scrollLockRef.current = lockDocumentScroll();
    dialog.showModal();
  }, []);
  const handleClose = useCallback(() => {
    const returnFocus = returnFocusRef.current;
    scrollLockRef.current?.release();
    scrollLockRef.current = null;
    onClose();
    requestAnimationFrame(() => returnFocus?.focus());
  }, [onClose]);
  const requestClose = useCallback(() => {
    const dialog = dialogRef.current;
    if (dialog?.open) {
      dialog.close();
      return;
    }
    handleClose();
  }, [handleClose]);

  if (!open) {
    return null;
  }

  return (
    <dialog
      aria-labelledby="download-dialog-title"
      className="download-dialog"
      onClose={handleClose}
      ref={showDialog}
    >
      <div className="download-dialog-shell">
        <div className="download-dialog-header">
          <div>
            <span className="eyebrow">BUILD SELECTOR / STABLE</span>
            <h2 id="download-dialog-title">Choose your machine.</h2>
          </div>
          <button
            aria-label="Close download chooser"
            className="dialog-close"
            onClick={requestClose}
            type="button"
          >
            ×
          </button>
        </div>
        <DownloadChooser manifestState={manifestState} onRetry={onRetry} />
      </div>
    </dialog>
  );
}
