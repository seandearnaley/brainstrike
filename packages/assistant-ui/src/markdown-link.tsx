import { createLogger } from '@brainstrike/logging';
import {
  type ComponentPropsWithoutRef,
  type MouseEvent,
  type ReactElement,
  useCallback,
} from 'react';
import { useAssistantLinkCapabilities } from './assistant-link-capabilities';

const logger = createLogger('AssistantMarkdownLink');

/** `MouseEvent.button` for the middle button, which fires `auxclick`, not `click`. */
const MIDDLE_MOUSE_BUTTON = 1;

/**
 * Same-document links: GFM footnote references (`#user-content-fn-1`), heading
 * anchors, and any `[x](#section)` the model emits.
 *
 * These must keep the anchor default. Electron's `will-navigate` is explicitly
 * "not emitted for in-page navigations, such as clicking anchor links", so they
 * were never caught by the renderer fence and already scroll correctly —
 * routing them to the host would break working behavior and pop an error toast.
 */
function isSameDocumentHref(href: string): boolean {
  return href.startsWith('#');
}

/**
 * The `a` renderer for assistant and user markdown.
 *
 * A plain markdown anchor pointing OFF the page is dead in the desktop
 * renderer: `create-window.ts` fences main-frame navigation to same-origin URLs
 * (Electron's documented "limit navigation" hardening), so the click is
 * `preventDefault()`ed by the main process and nothing happens. On web the same
 * anchor is worse — it navigates the SPA away and takes the live thread with
 * it. Neither platform can use the anchor default, so activation is handled
 * here and routed to the host.
 *
 * It stays a real `<a href>` rather than a button: that is what gives the user
 * the browser's own link affordances — the status-bar URL preview on hover,
 * "Copy link address" in the context menu, and tab focus order.
 *
 * `node` is already stripped by `memoizeMarkdownComponents`, so these are plain
 * anchor props.
 */
export function MarkdownLink({
  children,
  href,
  ...anchorProps
}: ComponentPropsWithoutRef<'a'>): ReactElement {
  const capabilities = useAssistantLinkCapabilities();

  const activate = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (href && isSameDocumentHref(href)) {
        return;
      }

      // Unconditional for off-page links: the anchor default is never the right
      // outcome, and a modifier-click ("open in a new tab") means the same
      // thing here — hand the URL to the host.
      event.preventDefault();

      if (!capabilities) {
        logger.error('Assistant link capabilities are missing; link activation ignored', { href });
        return;
      }

      // The host owns protocol policy and the single visible failure, so EVERY
      // off-page href goes to it — relative ones, and the empty string
      // react-markdown leaves behind when it sanitizes away a `javascript:`
      // URL. Short-circuiting any of them here would restore the silent dead
      // click: only the host can show the user why nothing opened.
      try {
        // `Promise.resolve` so a host that throws synchronously is caught by
        // the same handler as one that rejects.
        void Promise.resolve(capabilities.openLink(href ?? '')).catch((error: unknown) => {
          logger.error('Assistant link host rejected instead of resolving', { error, href });
        });
      } catch (error) {
        logger.error('Assistant link host threw instead of resolving', { error, href });
      }
    },
    [capabilities, href]
  );

  const handleAuxClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      // `auxclick` covers every non-primary button, so the secondary button
      // lands here too. Routing that would open the link on a right-click and
      // steal "Copy link address".
      if (event.button !== MIDDLE_MOUSE_BUTTON) {
        return;
      }
      activate(event);
    },
    [activate]
  );

  return (
    // Spread FIRST: `href`, `onClick` and `onAuxClick` are the invariants this
    // component exists to guarantee, so upstream props must not overwrite them.
    <a {...anchorProps} href={href} onAuxClick={handleAuxClick} onClick={activate}>
      {children}
    </a>
  );
}
