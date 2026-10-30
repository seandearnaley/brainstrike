import type * as React from 'react';
import { type RefObject, useEffect, useRef, useState } from 'react';
import ShikiHighlighter from 'react-shiki/core';
import { cn } from '../lib/utils';
import { normalizeShikiLanguage, useShikiHighlighter } from '../shiki/highlighter-core';
import { useCodeTheme } from '../theme-provider';
import { codeThemeShikiPair } from '../themes/code-themes';

export interface CodeBlockBodyProps {
  readonly className?: string;
  readonly code: string;
  readonly delay?: number | undefined;
  readonly fallback?: React.ReactNode;
  readonly language: string;
}

/**
 * Bottom half of the shared code-block box. A block is highlighted once it
 * comes near the visible area; until then it shows the plain fallback, which
 * keeps its text searchable and copyable. The wrapper div is CONSTANT across
 * the plain-fallback → Shiki swap so the box chrome never flashes and there is
 * no layout shift when highlighting resolves (padding/font metrics for both
 * states live on `.bs-code-block-body pre/.shiki` in globals.css @layer base).
 *
 * `showLanguage`/`addDefaultStyles` are both disabled. As of react-shiki 0.11
 * its CSS is no longer an opt-in stylesheet import: the rules are embedded in
 * the component chunk and self-install on first render via
 * `document.adoptedStyleSheets` (falling back to a `<style>` in `<head>`), so
 * they are live whether or not anything imports `react-shiki/css`. What keeps
 * that harmless here is the prop configuration:
 * - `:where(.rs-root.rs-default-styles pre)` (border-radius, padding, overflow)
 *   is gated off by `addDefaultStyles={false}`, so it never competes with the
 *   `.bs-code-block-body pre/.shiki` metrics above.
 * - `:where(.rs-root .rs-language-label)` never matches, because
 *   `showLanguage={false}` means no label element is rendered at all (the
 *   header owns the language text).
 * - `:where(.rs-root){position:relative}` is the one rule that does newly
 *   apply, to react-shiki's own container. Nothing in this subtree is
 *   absolutely positioned, so it is inert — but it is a real delta.
 *
 * `defaultColor={false}` makes Shiki emit only its `--shiki-light*` and
 * `--shiki-dark*` variables, no inline colour or background; globals.css picks
 * the side for the current theme and the box keeps its own surface.
 *
 * CAVEAT: react-shiki injects those rules UNLAYERED while ours live in
 * `@layer base`, and unlayered declarations beat layered ones regardless of
 * specificity — `:where()` scores 0 and would still win. Enabling
 * `addDefaultStyles` later would therefore silently override our padding and
 * rounding rather than lose to them.
 */
/**
 * Room around the visible area in which a block is highlighted ahead of being
 * scrolled to. A thread keeps every turn mounted, and highlighting all of its
 * blocks at once blocked opening a long thread (BST-2314).
 */
const HIGHLIGHT_AHEAD_MARGIN = '1200px 0px';

/** Whether the element has come within the highlight margin; it never turns back. */
function useNearViewport(ref: RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const element = ref.current;
    if (near || !element) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      // `scrollMargin` extends the margin into the thread's own scroller, which
      // clips intersections before `rootMargin` applies.
      { rootMargin: HIGHLIGHT_AHEAD_MARGIN, scrollMargin: HIGHLIGHT_AHEAD_MARGIN }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near, ref]);
  return near;
}

export function CodeBlockBody({
  className,
  code,
  delay,
  fallback,
  language,
}: CodeBlockBodyProps): React.ReactNode {
  const highlighter = useShikiHighlighter();
  const codeTheme = useCodeTheme();
  const bodyRef = useRef<HTMLDivElement>(null);
  const near = useNearViewport(bodyRef);

  return (
    <div
      className={cn(
        'bs-code-block-body border-border bg-muted/40 overflow-x-auto rounded-b-md border border-t-0',
        className
      )}
      ref={bodyRef}
    >
      {code && highlighter && near ? (
        <ShikiHighlighter
          addDefaultStyles={false}
          defaultColor={false}
          highlighter={highlighter}
          language={normalizeShikiLanguage(language)}
          showLanguage={false}
          theme={codeThemeShikiPair(codeTheme)}
          {...(delay === undefined ? {} : { delay })}
        >
          {code}
        </ShikiHighlighter>
      ) : (
        (fallback ?? (
          <pre>
            <code>{code}</code>
          </pre>
        ))
      )}
    </div>
  );
}
