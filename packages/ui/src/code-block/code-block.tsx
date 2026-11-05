import type * as React from 'react';
import { useState } from 'react';
import { cn } from '../lib/utils';
import { CodeBlockBody } from './code-block-body';
import { CodeBlockHeader } from './code-block-header';

export interface CodeBlockProps {
  readonly className?: string;
  readonly code: string;
  readonly delay?: number | undefined;
  readonly fallback?: React.ReactNode;
  readonly language: string;
  readonly streaming?: boolean | undefined;
}

/**
 * The shared code box: header (language, wrap toggle, copy) over the body, in
 * one wrapper that owns the wrap state both halves read. Every pipeline mounts
 * this composition: the chat renders it from its SyntaxHighlighter slot (with
 * no separate CodeHeader), the file and notes previews from their fence
 * component. `not-prose` keeps Typography's pre colours and fill out of the
 * box inside a markdown preview: the box owns its chrome.
 */
export function CodeBlock({
  className,
  code,
  delay,
  fallback,
  language,
  streaming,
}: CodeBlockProps): React.ReactNode {
  const [wrap, setWrap] = useState(false);
  return (
    <div className={cn('bs-code-block not-prose my-4', className)}>
      <CodeBlockHeader code={code} language={language} onWrapChange={setWrap} wrap={wrap} />
      <CodeBlockBody
        code={code}
        delay={delay}
        fallback={fallback}
        language={language}
        streaming={streaming}
        wrap={wrap}
      />
    </div>
  );
}
