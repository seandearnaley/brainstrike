import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

function bridgeTokens(): string[] {
  const globals = readFileSync(join(SRC, 'globals.css'), 'utf8');
  const bridge = globals.split('@media (prefers-contrast: more)')[0] ?? '';
  return [...bridge.matchAll(/^\s*--([a-z0-9-]+):\s*var\(--bs-[a-z0-9-]+\);/gmu)].map(
    (m) => m[1] ?? ''
  );
}

describe('theme.css mapping', () => {
  const themeCss = readFileSync(join(SRC, 'theme.css'), 'utf8');
  const inlineBlock =
    /@theme inline \{(?<body>[\s\S]*?)\n\}/u.exec(themeCss)?.groups?.['body'] ?? '';

  it('maps every colour token from the bridge with the inline idiom', () => {
    const tokens = bridgeTokens().filter((t) => t !== 'radius' && t !== 'panel-surface');
    expect(tokens.length).toBeGreaterThan(30);
    for (const token of tokens) {
      expect(inlineBlock, token).toContain(`--color-${token}: var(--${token});`);
    }
  });

  it('declares exactly the expected bridge tokens on :root', () => {
    // The bridge is the single seam between the `--bs-*` palette and the
    // Tailwind mapping. Pin it exactly: an extra token silently ships an
    // unmapped variable, a missing one silently drops a utility.
    const expected = [
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
      'warning',
      'warning-foreground',
      'border',
      'panel-divider',
      'panel-surface',
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
      'radius',
    ];
    expect(expected).toHaveLength(37);
    expect([...bridgeTokens()].sort()).toEqual([...expected].sort());
  });

  it('never wraps a mapping in hsl()', () => {
    expect(themeCss).not.toMatch(/hsl\(var\(/u);
  });

  it('exposes the font hooks and the radius scale inline', () => {
    expect(inlineBlock).toContain('--font-sans: var(--bs-font-sans);');
    expect(inlineBlock).toContain('--font-heading: var(--bs-font-heading);');
    expect(inlineBlock).toContain('--font-mono: var(--bs-font-mono);');
    expect(inlineBlock).toContain('--radius-md: calc(var(--radius) - 2px);');
  });

  it('declares the dark variant once', () => {
    expect(themeCss.match(/@custom-variant dark/gu)).toHaveLength(1);
  });
});
