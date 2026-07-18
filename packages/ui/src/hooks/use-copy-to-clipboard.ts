import { createClipboardService } from '@brainstrike/context-actions';
import { createLogger } from '@brainstrike/utils/logger';
import { useState } from 'react';

const logger = createLogger('UseCopyToClipboard');
const clipboard = createClipboardService();

export interface UseCopyToClipboardOptions {
  copiedDuration?: number;
}

/**
 * Copy-to-clipboard with a transient "copied" flag. Routes through the shared
 * clipboard service so a present-but-broken Electron bridge is surfaced
 * (never silently falls back to navigator).
 */
export function useCopyToClipboard({ copiedDuration = 2000 }: UseCopyToClipboardOptions = {}) {
  const [isCopied, setIsCopied] = useState(false);
  const copyToClipboard = (value: string) => {
    if (!value) {
      return;
    }
    const text = String(value);
    const markCopied = () => {
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), copiedDuration);
    };
    void clipboard.writeText(text).then((outcome) => {
      if (outcome.ok) {
        markCopied();
        return;
      }
      logger.warn('Failed to copy text to clipboard', { error: outcome.error });
    });
  };
  return { copyToClipboard, isCopied } as const;
}
