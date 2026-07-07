import type { SyntaxHighlighterProps } from '@assistant-ui/react-markdown';
import { createLogger } from '@brainstrike/utils/logger';
import { memo, useEffect, useMemo, useState } from 'react';
import ShikiHighlighter, { createHighlighterCore, createOnigurumaEngine } from 'react-shiki/core';
import type { HighlighterCore } from 'shiki';

/**
 * Syntax highlighter component using react-shiki
 *
 * Features:
 * - Modern, performant syntax highlighting with Shiki
 * - Dual theme support (light/dark)
 * - Core bundle with a curated language set to avoid invalid grammars in production
 * - Delay support for streamed code responses
 */

const logger = createLogger('SyntaxHighlighter');

const LANGUAGE_ALLOWLIST = new Set([
  'bash',
  'css',
  'diff',
  'go',
  'html',
  'javascript',
  'json',
  'jsx',
  'markdown',
  'python',
  'rust',
  'sql',
  'toml',
  'tsx',
  'typescript',
  'yaml',
]);

const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  md: 'markdown',
  sh: 'bash',
  shell: 'bash',
  ts: 'typescript',
  yml: 'yaml',
  zsh: 'bash',
};

let highlighterPromise: Promise<HighlighterCore> | null = null;
let highlighterCache: HighlighterCore | null = null;
let highlighterFailed = false;

const getHighlighter = (): Promise<HighlighterCore> => {
  if (highlighterCache) {
    return Promise.resolve(highlighterCache);
  }
  if (highlighterPromise) {
    return highlighterPromise;
  }

  highlighterPromise = createHighlighterCore({
    engine: createOnigurumaEngine(import('shiki/wasm')),
    langs: [
      import('@shikijs/langs/bash'),
      import('@shikijs/langs/css'),
      import('@shikijs/langs/diff'),
      import('@shikijs/langs/go'),
      import('@shikijs/langs/html'),
      import('@shikijs/langs/javascript'),
      import('@shikijs/langs/json'),
      import('@shikijs/langs/jsx'),
      import('@shikijs/langs/markdown'),
      import('@shikijs/langs/python'),
      import('@shikijs/langs/rust'),
      import('@shikijs/langs/sql'),
      import('@shikijs/langs/toml'),
      import('@shikijs/langs/tsx'),
      import('@shikijs/langs/typescript'),
      import('@shikijs/langs/yaml'),
    ],
    themes: [import('@shikijs/themes/github-light'), import('@shikijs/themes/github-dark')],
  })
    .then((instance) => {
      highlighterCache = instance;
      return instance;
    })
    .catch((error) => {
      highlighterFailed = true;
      logger.warn('Failed to initialize Shiki highlighter; falling back to plaintext', {
        error,
      });
      throw error;
    });

  return highlighterPromise;
};

const normalizeLanguage = (language: string | undefined) => {
  const raw = (language ?? '').trim().toLowerCase();
  if (!raw) {
    return 'plaintext';
  }
  const normalized = LANGUAGE_ALIASES[raw] ?? raw;
  return LANGUAGE_ALLOWLIST.has(normalized) ? normalized : 'plaintext';
};

const useHighlighter = (): HighlighterCore | null => {
  const [highlighter, setHighlighter] = useState<HighlighterCore | null>(highlighterCache);

  useEffect(() => {
    // If already cached or failed, no async work needed
    if (highlighterCache || highlighterFailed) {
      return;
    }

    let active = true;
    getHighlighter()
      .then((instance) => {
        if (active) {
          setHighlighter(instance);
        }
      })
      .catch(() => {
        if (active) {
          setHighlighter(null);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  // Return cached instance directly if available (bypasses stale state)
  return highlighterCache ?? highlighter;
};

const SyntaxHighlighterImpl = ({ language, code, components }: SyntaxHighlighterProps) => {
  const highlighter = useHighlighter();
  const resolvedLanguage = useMemo(() => normalizeLanguage(language), [language]);

  // If no code, return the Pre/Code components as fallback
  if (!code) {
    const { Pre, Code } = components;
    return (
      <Pre>
        <Code>{code}</Code>
      </Pre>
    );
  }

  if (!highlighter) {
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
      theme={{
        dark: 'github-dark',
        light: 'github-light',
      }}
    >
      {code}
    </ShikiHighlighter>
  );
};

export const SyntaxHighlighterComponent = memo(SyntaxHighlighterImpl);
