import { createLogger } from '@brainstrike/logging';
import { type ComponentPropsWithoutRef, type MouseEvent, useCallback } from 'react';
import { useAssistantLinkCapabilities } from './assistant-link-capabilities';

const logger = createLogger('AssistantMarkdownLink');

/**
 * The `a` renderer for assistant and user markdown.
 *
 * A plain markdown anchor is DEAD in the desktop renderer: `create-window.ts`
 * fences main-frame navigation to same-origin URLs (Electron's documented
 * "limit navigation" hardening), so the click is `preventDefault()`ed by the
 * main process and nothing happens. On web the same anchor is worse — it
 * navigates the SPA away and takes the live thread with it. Neither platform
 * can use the anchor default, so activation is always handled here and routed
 * to the host.
 *
 * It stays a real `<a href>` rather than a button: that is what gives the user
 * the browser's own link affordances — the status-bar URL preview on hover,
 * "Copy link address" in the context menu, and tab focus order.
 *
 * `node` is already stripped by `memoizeMarkdownComponents`, so these are plain
 * anchor props.
 */
export function MarkdownLink({ children, href, ...anchorProps }: ComponentPropsWithoutRef<'a'>) {
  const capabilities = useAssistantLinkCapabilities();

  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      // Unconditional: the anchor default is never the right outcome, and a
      // modifier-click ("open in a new tab") means the same thing here — hand
      // the URL to the host.
      event.preventDefault();

      if (!capabilities) {
        logger.error('Assistant link capabilities are missing; link activation ignored', { href });
        return;
      }

      // The host owns protocol policy and the single visible failure, so every
      // href goes to it — including relative ones, which must produce a real
      // "unsupported link" message rather than a dead click.
      void capabilities.openLink(href ?? '').catch((error: unknown) => {
        // The contract resolves `{ ok: false, error }`; a rejection is a broken
        // host implementation and must not be swallowed.
        logger.error('Assistant link host rejected instead of resolving', { error, href });
      });
    },
    [capabilities, href]
  );

  return (
    <a href={href} onClick={handleClick} {...anchorProps}>
      {children}
    </a>
  );
}
