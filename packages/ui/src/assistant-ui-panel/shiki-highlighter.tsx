import type { SyntaxHighlighterProps } from '@assistant-ui/react-markdown';
import { memo } from 'react';
import ShikiHighlighter from 'react-shiki';

/**
 * Syntax highlighter component using react-shiki
 *
 * Features:
 * - Modern, performant syntax highlighting with Shiki
 * - Dual theme support (light/dark)
 * - Tree-shakable and optimized for bundle size
 * - Delay support for streamed code responses
 */

const SyntaxHighlighterImpl = ({ language, code, components }: SyntaxHighlighterProps) => {
  // If no code, return the Pre/Code components as fallback
  if (!code) {
    const { Pre, Code } = components;
    return (
      <Pre>
        <Code>{code}</Code>
      </Pre>
    );
  }

  return (
    <ShikiHighlighter
      className="overflow-hidden rounded-md"
      delay={50}
      language={language || 'text'}
      theme={{
        light: 'github-light',
        dark: 'github-dark',
      }}
    >
      {code}
    </ShikiHighlighter>
  );
};

export const SyntaxHighlighterComponent = memo(SyntaxHighlighterImpl);
