// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guard for the defect class behind BST-963.
 *
 * The original bug was not a wrong number — it was that each floating layer
 * owned its own number. `DialogContent` was lifted from `z-50` to `z-[51]` in
 * #831 and the popup primitives were never told, so they silently ended up
 * underneath an opaque panel. Nothing failed; the numbers just drifted apart.
 *
 * So the invariant worth enforcing is structural: these files must not name a
 * z-index at all. They import a token from `layers.ts`, which is the only place
 * the scale is decided and the only place `layers.test.ts` has to check.
 */

const UI_SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

const FLOATING_LAYER_SOURCES = [
  'dialog.tsx',
  'select.tsx',
  'popover.tsx',
  'dropdown-menu.tsx',
  'context-menu/context-menu.tsx',
  'tooltip.tsx',
  'toast.tsx',
  'command-palette/command-palette.tsx',
  'command-palette/quick-open-palette.tsx',
  'model-picker/model-picker.tsx',
] as const;

/**
 * Matches `z-50`, `z-[51]`, `z-100` and variant-prefixed forms such as
 * `hover:z-50`, `sm:z-[60]`, `data-[state=open]:z-[52]` — a realistic way for
 * the drift to come back, since a variant compiles to a hardcoded z-index just
 * the same.
 *
 * The lookbehind is what admits the prefixed forms (the preceding character is
 * `:`) while still rejecting `translate-z-50` and the `--z-50` custom-property
 * spelling, where `z-` is part of a longer identifier.
 */
const HARDCODED_Z_UTILITY = /(?<![\w-])z-\[?\d+\]?/;

describe('floating layers take their z-index from the shared scale', () => {
  it.each(FLOATING_LAYER_SOURCES)('%s names no z-index of its own', (relativePath) => {
    const source = readFileSync(join(UI_SRC, relativePath), 'utf8');

    const offending = source
      .split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter(({ line }) => HARDCODED_Z_UTILITY.test(line));

    expect(
      offending,
      `${relativePath} hardcodes a z-index. Import a token from packages/ui/src/layers.ts instead — ` +
        'a local number is how BST-963 happened (the dialog tier moved, these did not).'
    ).toEqual([]);
  });

  it('keeps the scale itself in exactly one module', () => {
    const layers = readFileSync(join(UI_SRC, 'layers.ts'), 'utf8');
    expect(HARDCODED_Z_UTILITY.test(layers)).toBe(true);
  });

  // A guard is only worth its runtime if it recognises the shapes drift
  // actually takes, so pin both what it must catch and what it must not.
  it.each([
    'z-50',
    "'z-50',",
    'z-[51]',
    'z-100',
    'hover:z-50',
    'sm:z-[60]',
    'group-hover:z-50',
    'data-[state=open]:z-[52]',
  ])('recognises %s as a hardcoded z-index', (candidate) => {
    expect(HARDCODED_Z_UTILITY.test(candidate)).toBe(true);
  });

  it.each(['translate-z-50', '--z-50', 'z-index', 'zoom-out-95', 'z-auto'])(
    'does not mistake %s for a hardcoded z-index',
    (candidate) => {
      expect(HARDCODED_Z_UTILITY.test(candidate)).toBe(false);
    }
  );
});
