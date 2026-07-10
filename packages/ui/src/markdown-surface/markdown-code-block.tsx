import { memo } from 'react';
import ShikiHighlighter from 'react-shiki/core';
import { normalizeShikiLanguage, useShikiHighlighter } from '../shiki/highlighter-core';

export interface MarkdownCodeBlockProps {
  readonly code: string;
  readonly language: string;
}

/** Fenced-code renderer for the markdown preview. Shares the app-wide cached
 * Shiki instance with the assistant chat. Falls back to a plain <pre> until
 * (or if) the highlighter is unavailable — the code is always visible. */
export const MarkdownCodeBlock = memo(function MarkdownCodeBlock({
  code,
  language,
}: MarkdownCodeBlockProps) {
  const highlighter = useShikiHighlighter();
  if (!highlighter) {
    return (
      <pre className="overflow-x-auto rounded-md bg-muted p-3 text-sm">
        <code>{code}</code>
      </pre>
    );
  }
  return (
    <ShikiHighlighter
      className="overflow-hidden rounded-md"
      highlighter={highlighter}
      language={normalizeShikiLanguage(language)}
      theme={{ dark: 'github-dark', light: 'github-light' }}
    >
      {code}
    </ShikiHighlighter>
  );
});
