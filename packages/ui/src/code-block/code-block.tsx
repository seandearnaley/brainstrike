import type * as React from 'react';
import { cn } from '../lib/utils';
import { CodeBlockBody } from './code-block-body';
import { CodeBlockHeader } from './code-block-header';

export interface CodeBlockProps {
  readonly className?: string;
  readonly code: string;
  readonly delay?: number | undefined;
  readonly language: string;
}

/**
 * Composed code box (header + body in one wrapper) for pipelines that own the
 * whole fence element (file preview, notes). The chat pipeline cannot use this
 * composition — @assistant-ui/react-markdown renders header and highlighter as
 * siblings — so it mounts CodeBlockHeader/CodeBlockBody separately; the halves
 * share the border/rounding contract and read as the same box.
 */
export function CodeBlock({ className, code, delay, language }: CodeBlockProps): React.ReactNode {
  return (
    <div className={cn('bs-code-block my-4', className)}>
      <CodeBlockHeader code={code} language={language} />
      <CodeBlockBody code={code} delay={delay} language={language} />
    </div>
  );
}
