import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, isThemeId, THEMES } from '../themes';

const THEMES_DIR = join(process.cwd(), 'src', 'themes');
const PACKAGE_JSON = join(process.cwd(), 'package.json');

const REQUIRED_COLOUR_TOKENS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'border',
  'input',
  'ring',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'sidebar',
  'sidebar-foreground',
  'sidebar-primary',
  'sidebar-primary-foreground',
  'sidebar-accent',
  'sidebar-accent-foreground',
  'sidebar-border',
  'sidebar-ring',
  'panel-divider',
  'panel-surface',
] as const;

function block(source: string, selector: string): string {
  const escaped = selector.replace(/[.[\]]/gu, '\\$&');
  const match = new RegExp(`^${escaped} \\{([\\s\\S]*?)^\\}`, 'mu').exec(source);
  if (!match) {
    throw new Error(`selector ${selector} missing`);
  }
  return match[1] ?? '';
}

describe('theme registry', () => {
  const cssFiles = readdirSync(THEMES_DIR).filter((f) => f.endsWith('.css') && f !== 'index.css');
  const indexCss = readFileSync(join(THEMES_DIR, 'index.css'), 'utf8');
  const buildScript = (
    JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { scripts: { build: string } }
  ).scripts.build;

  it('has one css file per registry entry and one entry per css file', () => {
    expect(cssFiles.sort()).toEqual(THEMES.map((t) => `${t.id}.css`).sort());
  });

  it('imports every theme exactly once and copies it to dist', () => {
    for (const theme of THEMES) {
      expect(indexCss.match(new RegExp(`@import "\\./${theme.id}\\.css";`, 'gu'))).toHaveLength(1);
      expect(buildScript).toContain(`src/themes/${theme.id}.css dist/themes/${theme.id}.css`);
    }
    expect(buildScript).toContain('src/themes/index.css dist/themes/index.css');
  });

  it('scopes every generated theme and declares the complete token set in both modes', () => {
    for (const theme of THEMES.filter((t) => t.id !== DEFAULT_THEME)) {
      const source = readFileSync(join(THEMES_DIR, `${theme.id}.css`), 'utf8');
      expect(source).toContain(`preset ${theme.presetCode}`);
      const light = block(source, `:root[data-theme="${theme.id}"]`);
      const dark = block(source, `:root[data-theme="${theme.id}"].dark`);
      for (const token of REQUIRED_COLOUR_TOKENS) {
        expect(light, `${theme.id} light --bs-${token}`).toMatch(new RegExp(`--bs-${token}:`, 'u'));
        expect(dark, `${theme.id} dark --bs-${token}`).toMatch(new RegExp(`--bs-${token}:`, 'u'));
      }
      expect(light).toMatch(/--bs-radius:/u);
      expect(source).not.toMatch(/^:root \{|^\.dark \{/mu);
    }
  });

  it('keeps focus rings near-neutral in every generated theme', () => {
    for (const theme of THEMES.filter((t) => t.id !== DEFAULT_THEME)) {
      const source = readFileSync(join(THEMES_DIR, `${theme.id}.css`), 'utf8');
      const rings = [...source.matchAll(/--bs-(?:sidebar-)?ring:\s*oklch\([\d.]+\s+([\d.]+)\s/gu)];
      expect(rings).toHaveLength(4);
      for (const ring of rings) {
        expect(Number(ring[1])).toBeLessThanOrEqual(0.04);
      }
    }
  });

  it('exposes a default, a guard and swatches', () => {
    expect(isThemeId(DEFAULT_THEME)).toBe(true);
    expect(isThemeId('nope')).toBe(false);
    expect(isThemeId(undefined)).toBe(false);
    for (const theme of THEMES) {
      expect(theme.swatch.light.background).toMatch(/^(?:hsl|oklch)\(/u);
      expect(theme.swatch.dark.primary).toMatch(/^(?:hsl|oklch)\(/u);
    }
  });
});
