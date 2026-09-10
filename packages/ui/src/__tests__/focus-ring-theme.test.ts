import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const UI_SOURCE_ROOT = join(process.cwd(), 'src');

describe('focus ring theme', () => {
  it('keeps global and sidebar focus tokens neutral in every mode of the baseline theme', () => {
    const source = readFileSync(join(UI_SOURCE_ROOT, 'themes', 'brainstrike.css'), 'utf8');
    const focusTokenDeclarations = [...source.matchAll(/--bs-(?:sidebar-)?ring:\s*hsl\((\d+)\s/gu)];

    expect(focusTokenDeclarations.length).toBe(4);
    for (const declaration of focusTokenDeclarations) {
      const hue = Number(declaration[1]);
      expect(hue === 0 || (hue >= 20 && hue <= 40)).toBe(true);
    }
  });

  it('keeps high-contrast focus tokens neutral', () => {
    const source = readFileSync(join(UI_SOURCE_ROOT, 'globals.css'), 'utf8');
    const highContrast = source.split('@media (prefers-contrast: more)')[1] ?? '';
    const declarations = [...highContrast.matchAll(/--bs-(?:sidebar-)?ring:\s*hsl\((\d+)\s/gu)];
    expect(declarations.length).toBe(4);
    for (const declaration of declarations) {
      expect(Number(declaration[1])).toBe(0);
    }
  });
});
