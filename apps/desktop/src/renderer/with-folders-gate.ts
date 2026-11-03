interface ComposerNotice {
  readonly disabledReason?: string | undefined;
  readonly isComposerDisabled?: boolean | undefined;
}

/** What the composer says while it holds a send for the thread's folders to open. */
export const OPENING_THREAD_FOLDERS = "Opening this thread's folders…";

/**
 * The composer presentation while the thread's folders are opening again: a notice that already
 * gates the send stays first; otherwise the send waits, since the host would refuse it for a
 * folder about to open.
 */
export function withFoldersGate<Presentation extends ComposerNotice>(
  presentation: Presentation,
  reopening: boolean
): Presentation {
  if (!reopening || presentation.isComposerDisabled === true) {
    return presentation;
  }
  return { ...presentation, disabledReason: OPENING_THREAD_FOLDERS, isComposerDisabled: true };
}
