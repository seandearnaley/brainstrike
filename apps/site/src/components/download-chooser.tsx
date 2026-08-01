import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useRef } from 'react';
import type { ReleaseManifestState } from '../releases/use-release-manifest';
import {
  buildDownloadViewModel,
  type DownloadActionView,
  type DownloadPlatformView,
} from './download-view-model';
import { type DocumentScrollLock, lockDocumentScroll } from './modal-scroll-lock';

interface DownloadChooserBaseProps {
  readonly manifestState: ReleaseManifestState;
  readonly onRetry?: (() => void) | undefined;
}

type DownloadChooserProps =
  | (DownloadChooserBaseProps & {
      readonly onOpenFull: () => void;
      readonly presentation: 'terminal';
    })
  | (DownloadChooserBaseProps & {
      readonly onOpenFull?: never;
      readonly presentation?: 'full';
    });

function FullDownloadActions({ platform }: { readonly platform: DownloadPlatformView }) {
  if (platform.actions.length === 0) {
    return <span className="platform-pending">Not published</span>;
  }
  return platform.actions.map((action) => (
    <a href={action.asset.url} key={action.asset.name} rel="noreferrer" target="_blank">
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
  readonly onOpenFull: () => void;
}) {
  if (actionCount > 1) {
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
      <a
        aria-label={`Download ${action.label}`}
        href={action.asset.url}
        rel="noreferrer"
        target="_blank"
      >
        Download <span aria-hidden="true">↓</span>
      </a>
    );
  }
  return <span className="platform-pending">Pending</span>;
}

export function DownloadChooser(props: DownloadChooserProps) {
  const { manifestState, onRetry } = props;
  const presentation = props.presentation ?? 'full';
  const view = buildDownloadViewModel(manifestState);
  const statusRole =
    view.status.kind === 'error' || view.status.kind === 'warning' ? 'alert' : 'status';

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
        {(view.status.kind === 'error' || view.status.kind === 'warning') && onRetry ? (
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
              {props.presentation === 'terminal' ? (
                <TerminalDownloadAction
                  action={platform.actions[0]}
                  actionCount={platform.actions.length}
                  onOpenFull={props.onOpenFull}
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
            Links are declared by the public release manifest. SHA-256 metadata is shown.{' '}
            <a href={view.releasesHubUrl} rel="noreferrer" target="_blank">
              All release assets <span aria-hidden="true">↗</span>
            </a>
          </>
        ) : (
          'Direct links appear only after a public release manifest names an asset. SHA-256 metadata will be shown.'
        )}
      </p>
    </section>
  );
}

interface DownloadDialogProps extends DownloadChooserBaseProps {
  readonly onClose: () => void;
  readonly open: boolean;
}

function focusableDialogControls(dialog: HTMLDialogElement): readonly HTMLElement[] {
  return [
    ...dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ),
  ].filter((element) => !(element.hidden || element.getAttribute('aria-hidden') === 'true'));
}

function focusInitialDialogControl(dialog: HTMLDialogElement): void {
  const initialControl = dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]');
  if (!initialControl) {
    throw new Error('The download dialog requires an initial focus control.');
  }
  initialControl.focus();
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
    dialogRef.current = dialog;
    if (!scrollLockRef.current) {
      scrollLockRef.current = lockDocumentScroll();
    }
    if (dialog.open) {
      focusInitialDialogControl(dialog);
      return;
    }
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    try {
      dialog.showModal();
      focusInitialDialogControl(dialog);
    } catch (error: unknown) {
      scrollLockRef.current.release();
      scrollLockRef.current = null;
      dialogRef.current = null;
      throw error;
    }
  }, []);
  const handleClose = useCallback(() => {
    const returnFocus = returnFocusRef.current;
    const scrollLock = scrollLockRef.current;
    scrollLockRef.current = null;
    onClose();
    queueMicrotask(() => {
      scrollLock?.release();
      returnFocus?.focus({ preventScroll: true });
    });
  }, [onClose]);
  const requestClose = useCallback(() => {
    const dialog = dialogRef.current;
    if (dialog?.open) {
      dialog.close();
      return;
    }
    handleClose();
  }, [handleClose]);
  const keepFocusInDialog = useCallback((event: ReactKeyboardEvent<HTMLDialogElement>): void => {
    if (event.key !== 'Tab') {
      return;
    }
    const controls = focusableDialogControls(event.currentTarget);
    const first = controls[0];
    const last = controls.at(-1);
    if (!(first && last)) {
      return;
    }
    const activeElement = document.activeElement;
    if (
      event.shiftKey &&
      (activeElement === first || !event.currentTarget.contains(activeElement))
    ) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (
      !event.shiftKey &&
      (activeElement === last || !event.currentTarget.contains(activeElement))
    ) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  if (!open) {
    return null;
  }

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: The modal dialog owns its keyboard focus-containment boundary.
    <dialog
      aria-labelledby="download-dialog-title"
      className="download-dialog"
      onClose={handleClose}
      onKeyDown={keepFocusInDialog}
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
            autoFocus
            className="dialog-close"
            data-dialog-initial-focus
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
