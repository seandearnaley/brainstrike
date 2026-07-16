import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const UI_SOURCE_ROOT = join(process.cwd(), 'src');

describe('focus ring theme', () => {
  it('keeps global and sidebar focus tokens neutral in every theme mode', () => {
    const source = readFileSync(join(UI_SOURCE_ROOT, 'globals.css'), 'utf8');
    const focusTokenDeclarations = [...source.matchAll(/--bs-(?:sidebar-)?ring:\s*(\d+)\s/g)];

    expect(focusTokenDeclarations.length).toBeGreaterThanOrEqual(6);
    for (const declaration of focusTokenDeclarations) {
      const hue = Number(declaration[1]);
      expect(hue === 0 || (hue >= 20 && hue <= 40)).toBe(true);
    }
  });
});
