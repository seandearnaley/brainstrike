import { createClipboardService } from '@brainstrike/context-actions';
import { createLogger } from '@brainstrike/utils/logger';
import { useEffect, useRef, useState } from 'react';

const logger = createLogger('UseCopyToClipboard');
const clipboard = createClipboardService();

export type CopyToClipboardStatus = 'copied' | 'failed' | 'idle';

export interface UseCopyToClipboardOptions {
  copiedDuration?: number;
}

/**
 * Copy-to-clipboard with transient "copied" / "failed" flags. Routes through
 * the shared clipboard service so a present-but-broken Electron bridge is
 * surfaced (never silently falls back to navigator). Failure is exposed as
 * state — consumers MUST render it visibly (repo rule: broken capabilities
 * never degrade quietly); both outcomes auto-reset after `copiedDuration`.
 */
export function useCopyToClipboard({ copiedDuration = 2000 }: UseCopyToClipboardOptions = {}) {
  const [status, setStatus] = useState<CopyToClipboardStatus>('idle');
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Chat code blocks remount per streamed chunk and file tabs close, so this
  // hook mounts/unmounts frequently -- a reset timer left running after
  // unmount is a dangling timer and (in tests) an act(...) warning on the
  // eventual late setState. Clear it on unmount. clearTimeout is a no-op for
  // a null/already-fired handle, so no guard is needed here.
  useEffect(() => () => clearTimeout(resetTimerRef.current ?? undefined), []);

  const copyToClipboard = (value: string) => {
    if (!value) {
      return;
    }
    const text = String(value);
    const settle = (outcome: Exclude<CopyToClipboardStatus, 'idle'>) => {
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
      }
      setStatus(outcome);
      resetTimerRef.current = setTimeout(() => setStatus('idle'), copiedDuration);
    };
    void clipboard
      .writeText(text)
      .then((outcome) => {
        if (outcome.ok) {
          settle('copied');
          return;
        }
        logger.warn('Failed to copy text to clipboard', { error: outcome.error });
        settle('failed');
      })
      .catch((error: unknown) => {
        logger.warn('Failed to copy text to clipboard', { error });
        settle('failed');
      });
  };

  return {
    copyToClipboard,
    isCopied: status === 'copied',
    isFailed: status === 'failed',
    status,
  } as const;
}
