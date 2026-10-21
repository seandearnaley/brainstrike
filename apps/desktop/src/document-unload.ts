import { createLogger } from '@brainstrike/logging';
import { BrowserWindow } from 'electron';
import { closeDesktopRenderers, type ShutdownRendererWindow } from './close-desktop-renderers';
import type { LifecycleDelaySeam } from './lifecycle-delay-seam';
import { prepareDocumentUnload, type RendererCloseWindow } from './prepare-document-unload';
import { getWindowRole } from './window-role';

const logger = createLogger('DocumentUnload');

/**
 * Every unload of a visible document flushes its durable writers first (ADR-0026 R1): quit's
 * `renderers` step, a user's window close (window-X, Alt+F4, Cmd+W) and every reload Main owns.
 * Main prepares the document (`prepareDocumentUnload`, whose ladder is the only escalation),
 * then unloads it whatever the answer: the document is closed or replaced either way.
 */
export type DocumentWindow = RendererCloseWindow &
  ShutdownRendererWindow & {
    on(event: 'close', listener: (event: { preventDefault(): void }) => void): unknown;
  };

export interface DocumentUnloadOwner<Window extends DocumentWindow> {
  readonly delays: Pick<LifecycleDelaySeam, 'delay'>;
  /** Quit has started: its `renderers` step prepares and closes every visible window. */
  readonly isQuitting: () => boolean;
  /** Closing the last visible window quits the app (Windows and Linux; macOS stays running). */
  readonly lastWindowQuits: boolean;
  readonly quit: () => void;
  /** The live visible documents; hidden renderer hosts are never among them. */
  readonly visibleWindows: () => readonly Window[];
}

/** The live visible documents; a hidden renderer host is never one. */
export function visibleDocumentWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (window) => !window.isDestroyed() && getWindowRole(window) === 'visible-ui'
  );
}

/** Windows whose close Main itself issues after preparing their document. */
const admittedCloses = new Set<DocumentWindow>();
/** Windows whose user close is preparing their document. */
const unloading = new Set<DocumentWindow>();

function untilClosed(set: Set<DocumentWindow>, window: DocumentWindow): void {
  if (set.has(window)) {
    return;
  }
  set.add(window);
  window.once('closed', () => {
    set.delete(window);
  });
}

/** Lets Main's own `close()` of this prepared window through the close interception. */
export function admitDocumentClose(window: DocumentWindow): void {
  untilClosed(admittedCloses, window);
}

/** Prepares the document for unload; a failure is logged, and the unload still proceeds. */
export async function flushDocumentBeforeUnload(
  window: DocumentWindow,
  delays: Pick<LifecycleDelaySeam, 'delay'>
): Promise<void> {
  try {
    await prepareDocumentUnload(window, delays);
  } catch (error) {
    logger.error('Document unloads without confirming its durable writers flushed', { error });
  }
}

/**
 * A reload Main owns (menu Reload, developer database reset, a renderer's reload request):
 * the document flushes, then is replaced. Quit owns every window once it has started.
 */
export async function reloadDocument(
  window: DocumentWindow,
  owner: Pick<DocumentUnloadOwner<DocumentWindow>, 'delays' | 'isQuitting'>,
  reload: () => void
): Promise<void> {
  await flushDocumentBeforeUnload(window, owner.delays);
  if (window.isDestroyed() || owner.isQuitting()) {
    return;
  }
  reload();
}

async function closeDocument(
  window: DocumentWindow,
  delays: Pick<LifecycleDelaySeam, 'delay'>
): Promise<void> {
  await flushDocumentBeforeUnload(window, delays);
  admitDocumentClose(window);
  try {
    await closeDesktopRenderers([window], () => false);
  } catch (error) {
    logger.error('Window did not close after its document unload', { error });
  }
}

/**
 * Intercepts every close of a visible window that Main did not issue itself: the document
 * flushes first, then Main closes it again (normal close, so `beforeunload`/`pagehide` and
 * window-state persistence still run). On Windows and Linux the last visible window's close
 * is the app's quit instead, and quit prepares and closes it. A page never vetoes an unload
 * Main owns.
 */
export function installDocumentUnload<Window extends DocumentWindow>(
  window: Window,
  owner: DocumentUnloadOwner<Window>
): void {
  window.webContents.on('will-prevent-unload', (event) => {
    event.preventDefault();
  });
  window.on('close', (event) => {
    if (admittedCloses.has(window)) {
      return;
    }
    event.preventDefault();
    if (owner.isQuitting() || unloading.has(window)) {
      return;
    }
    const othersOpen = owner
      .visibleWindows()
      .some((other) => other !== window && !other.isDestroyed() && !unloading.has(other));
    if (owner.lastWindowQuits && !othersOpen) {
      owner.quit();
      return;
    }
    untilClosed(unloading, window);
    void closeDocument(window, owner.delays);
  });
}
