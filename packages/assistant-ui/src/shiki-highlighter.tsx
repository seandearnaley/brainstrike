import type { SyntaxHighlighterProps } from '@assistant-ui/react-streamdown';
import { CodeBlock } from '@brainstrike/ui/code-block';
import { memo } from 'react';
import { useIsCodeFenceIncomplete } from 'streamdown';

/**
 * Chat-pipeline adapter over the shared CodeBlock. The chat registers no
 * separate CodeHeader, so this slot renders the whole box: the header with the
 * wrap and copy controls, and the body that shares their state. A fence that
 * is still streaming stays at full height; once it closes a long one
 * collapses. delay=50 keeps re-highlights coalesced during streaming. The
 * pre-highlight fallback reuses the library's Pre/Code components so streamed
 * markdown swaps to Shiki without remounting semantics.
 */
const SyntaxHighlighterImpl = ({ language, code, components }: SyntaxHighlighterProps) => {
  const { Pre, Code } = components;
  const streaming = useIsCodeFenceIncomplete();
  return (
    <CodeBlock
      code={code}
      delay={50}
      fallback={
        <Pre>
          <Code>{code}</Code>
        </Pre>
      }
      language={language}
      streaming={streaming}
    />
  );
};

export const SyntaxHighlighterComponent = memo(SyntaxHighlighterImpl);
