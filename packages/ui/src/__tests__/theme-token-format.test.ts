import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const THEMES_DIR = join(process.cwd(), 'src', 'themes');
const GLOBALS = join(process.cwd(), 'src', 'globals.css');

const COLOUR_VALUE = /^(?:hsl|oklch|color-mix|linear-gradient)\(/u;
const NON_COLOUR_TOKENS = new Set(['radius', 'font-sans', 'font-heading', 'font-mono']);

function collectBsDeclarations(source: string): Array<{ name: string; value: string }> {
  return [...source.matchAll(/--bs-([a-z0-9-]+):\s*([^;]+);/gu)].map((match) => ({
    name: match[1] ?? '',
    value: (match[2] ?? '').trim(),
  }));
}

describe('theme token format', () => {
  it('brainstrike.css declares every --bs-* colour as a complete colour value', () => {
    const source = readFileSync(join(THEMES_DIR, 'brainstrike.css'), 'utf8');
    const declarations = collectBsDeclarations(source);
    expect(declarations.length).toBeGreaterThan(80);
    for (const { name, value } of declarations) {
      if (NON_COLOUR_TOKENS.has(name)) {
        continue;
      }
      expect(value, `--bs-${name}: ${value}`).toMatch(COLOUR_VALUE);
    }
  });

  it('brainstrike.css declares the font hooks on :root', () => {
    const source = readFileSync(join(THEMES_DIR, 'brainstrike.css'), 'utf8');
    expect(source).toMatch(/--bs-font-sans:\s*"Geist Variable"/u);
    expect(source).toMatch(/--bs-font-heading:\s*var\(--bs-font-sans\)/u);
    expect(source).toMatch(/--bs-font-mono:\s*"Geist Mono Variable"/u);
  });

  it('globals.css no longer owns palette values', () => {
    const source = readFileSync(GLOBALS, 'utf8');
    const outsideHighContrast = source.split('@media (prefers-contrast: more)')[0] ?? '';
    expect(collectBsDeclarations(outsideHighContrast)).toHaveLength(0);
    expect(source).toMatch(/^@import "\.\/themes\/index\.css";/mu);
  });

  it('the high-contrast override also uses complete colour values', () => {
    const source = readFileSync(GLOBALS, 'utf8');
    const highContrast = source.split('@media (prefers-contrast: more)')[1] ?? '';
    for (const { name, value } of collectBsDeclarations(highContrast)) {
      expect(value, `--bs-${name}: ${value}`).toMatch(COLOUR_VALUE);
    }
  });
});
