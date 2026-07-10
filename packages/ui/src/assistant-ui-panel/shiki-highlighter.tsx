import type { SyntaxHighlighterProps } from '@assistant-ui/react-markdown';
import { memo, useMemo } from 'react';
import ShikiHighlighter from 'react-shiki/core';
import { normalizeShikiLanguage, useShikiHighlighter } from '../shiki/highlighter-core';

const SyntaxHighlighterImpl = ({ language, code, components }: SyntaxHighlighterProps) => {
  const highlighter = useShikiHighlighter();
  const resolvedLanguage = useMemo(() => normalizeShikiLanguage(language), [language]);

  if (!(code && highlighter)) {
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
      highlighter={highlighter}
      language={resolvedLanguage}
      theme={{ dark: 'github-dark', light: 'github-light' }}
    >
      {code}
    </ShikiHighlighter>
  );
};

export const SyntaxHighlighterComponent = memo(SyntaxHighlighterImpl);
