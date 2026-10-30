import { createLogger } from '@brainstrike/logging';
import { useEffect, useState } from 'react';
import { createHighlighterCore, createOnigurumaEngine } from 'react-shiki/core';
import type { HighlighterCore } from 'shiki';

const logger = createLogger('SyntaxHighlighter');

/**
 * Modern, performant syntax highlighting with Shiki. Provides dual theme support
 * (a light/dark pair per code theme in themes/code-themes.ts) and builds the core bundle from a curated language set —
 * the allowlist below avoids pulling invalid or unnecessary grammars into production —
 * with async loading tuned for delayed/streamed code responses.
 */
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
    // Every Shiki theme a code theme names (themes/code-themes.ts).
    themes: [
      import('@shikijs/themes/catppuccin-latte'),
      import('@shikijs/themes/catppuccin-mocha'),
      import('@shikijs/themes/github-dark'),
      import('@shikijs/themes/github-light'),
      import('@shikijs/themes/monokai'),
      import('@shikijs/themes/one-dark-pro'),
      import('@shikijs/themes/one-light'),
      import('@shikijs/themes/solarized-dark'),
      import('@shikijs/themes/solarized-light'),
    ],
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

/** Loads the highlighter (its wasm and every grammar) before a code block needs it. */
export async function preloadShikiHighlighter(): Promise<void> {
  await getHighlighter();
}

export const normalizeShikiLanguage = normalizeLanguage;
export const useShikiHighlighter = useHighlighter;
