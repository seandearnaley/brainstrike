import { createLogger } from '@brainstrike/logging';
import { toast } from '@brainstrike/ui';
import type { OpenLinkResult } from './open-external-link';

const MAX_TOASTED_URL_LENGTH = 120;
const logger = createLogger('LinkFailure');

/** Model-authored URLs are untrusted and can be arbitrarily long; a toast is
 * not the place to render one in full. */
function truncate(url: string): string {
  return url.length > MAX_TOASTED_URL_LENGTH ? `${url.slice(0, MAX_TOASTED_URL_LENGTH)}…` : url;
}

/**
 * Report a link failure to the user.
 *
 * Without this the click is indistinguishable from the bug being fixed:
 * something the user clicked, and nothing happened. The REASON matters too —
 * "unsupported protocol" and "the shell failed" call for different reactions,
 * and the URL alone distinguishes neither.
 */
export function reportLinkFailure(title: string, result: OpenLinkResult, url: string): void {
  try {
    toast({
      // Joined rather than interpolated: a sanitized-away href arrives here as
      // '', and "<reason> — " with nothing after it reads like a rendering bug
      // rather than an explanation.
      description: [result.error, truncate(url)].filter(Boolean).join(' — '),
      title,
      variant: 'destructive',
    });
  } catch (error) {
    // Link handlers promise never to reject, and that has to hold even when
    // the only thing left to fail is the failure reporter itself.
    logger.error('Failed to surface a link failure to the user', { error, url });
  }
}
