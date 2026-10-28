import type * as React from 'react';
import ShikiHighlighter from 'react-shiki/core';
import { cn } from '../lib/utils';
import { normalizeShikiLanguage, useShikiHighlighter } from '../shiki/highlighter-core';

export interface CodeBlockBodyProps {
  readonly className?: string;
  readonly code: string;
  readonly delay?: number | undefined;
  readonly fallback?: React.ReactNode;
  readonly language: string;
}

/**
 * Bottom half of the shared code-block box. The wrapper div is CONSTANT across
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
export function CodeBlockBody({
  className,
  code,
  delay,
  fallback,
  language,
}: CodeBlockBodyProps): React.ReactNode {
  const highlighter = useShikiHighlighter();

  return (
    <div
      className={cn(
        'bs-code-block-body overflow-x-auto rounded-b-md border border-border border-t-0 bg-muted/40',
        className
      )}
    >
      {code && highlighter ? (
        <ShikiHighlighter
          addDefaultStyles={false}
          defaultColor={false}
          highlighter={highlighter}
          language={normalizeShikiLanguage(language)}
          showLanguage={false}
          theme={{ dark: 'monokai', light: 'github-light' }}
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
