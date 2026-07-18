import { memo } from 'react';
import { CodeBlock } from '../code-block/code-block';

export interface MarkdownCodeBlockProps {
  readonly code: string;
  readonly language: string;
}

/** Fenced-code renderer for the markdown preview: the shared code box
 * (language header + copy + Shiki body). Shares the app-wide cached Shiki
 * instance with the assistant chat; the body falls back to a plain <pre>
 * until (or if) the highlighter is unavailable — the code is always visible.
 * Relative import keeps this in the markdown-surface lazy chunk. */
export const MarkdownCodeBlock = memo(function MarkdownCodeBlock({
  code,
  language,
}: MarkdownCodeBlockProps) {
  return <CodeBlock code={code} language={language} />;
});
