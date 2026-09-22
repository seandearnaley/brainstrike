import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import configPackage from '../package.json';

// BST-1734: the Tailwind v3 preset is dead — no stylesheet references it via
// `@config` and the v4 Vite plugin never loads `tailwind.config.js`. This pins
// the removal so the legacy `hsl(var(--x))` surface cannot drift back in.
const root = resolve(import.meta.dirname, '..', '..', '..');

describe('tailwind v3 preset removal', () => {
  it('has no tailwind.config.js preset or app configs', () => {
    expect(existsSync(resolve(root, 'packages/config/tailwind/tailwind.config.js'))).toBe(false);
    expect(existsSync(resolve(root, 'apps/web/tailwind.config.js'))).toBe(false);
    expect(existsSync(resolve(root, 'apps/desktop/tailwind.config.js'))).toBe(false);
  });

  it('exposes no ./tailwind export', () => {
    expect('./tailwind' in (configPackage.exports as Record<string, unknown>)).toBe(false);
  });

  it('references no legacy preset from test fixtures', () => {
    const fixture = readFileSync(
      resolve(root, 'packages/assistant-ui/src/__tests__/assistant-conversation-panel.browser.css'),
      'utf8'
    );
    expect(fixture).not.toContain('@config');
    expect(fixture).not.toContain('config/tailwind');
  });
});
