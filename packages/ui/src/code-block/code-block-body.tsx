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
 * `showLanguage`/`addDefaultStyles` are disabled: the repo never imports
 * react-shiki's stylesheet, so the library's own language label rendered as an
 * unstyled stray span and its default pre styles never applied.
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
          highlighter={highlighter}
          language={normalizeShikiLanguage(language)}
          showLanguage={false}
          theme={{ dark: 'github-dark', light: 'github-light' }}
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
