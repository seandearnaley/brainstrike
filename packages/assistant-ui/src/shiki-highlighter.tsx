import type { SyntaxHighlighterProps } from '@assistant-ui/react-streamdown';
import { CodeBlockBody } from '@brainstrike/ui/code-block';
import { memo } from 'react';

/**
 * Chat-pipeline adapter over the shared CodeBlockBody. The library renders
 * this as a SIBLING of CodeHeader (never nested), so the body carries the
 * bottom half of the shared box chrome; delay=50 keeps re-highlights coalesced
 * during streaming. The pre-highlight fallback reuses the library's Pre/Code
 * components so streamed markdown swaps to Shiki without remounting semantics.
 */
const SyntaxHighlighterImpl = ({ language, code, components }: SyntaxHighlighterProps) => {
  const { Pre, Code } = components;
  return (
    <CodeBlockBody
      code={code}
      delay={50}
      fallback={
        <Pre>
          <Code>{code}</Code>
        </Pre>
      }
      language={language}
    />
  );
};

export const SyntaxHighlighterComponent = memo(SyntaxHighlighterImpl);
