import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const indexUrl = new URL('../index.ts', import.meta.url);

async function loadModule() {
  const url = new URL('../index.ts', import.meta.url);
  return import(url.href);
}

describe('resolveFontPath', () => {
  it('uses import.meta.url by default', async () => {
    const { resolveFontPath } = await loadModule();
    const dir = path.dirname(fileURLToPath(indexUrl));
    const expected = path.join(dir, 'inter/foo.ttf');
    expect(resolveFontPath('foo.ttf')).toBe(expected);
  });

  it('contains __dirname fallback in source', () => {
    const src = fs.readFileSync(indexUrl, 'utf8');
    expect(src).toMatch(/typeof __dirname/);
  });
});

describe('INTER_FONT_PATHS', () => {
  it('exposes correct file names', async () => {
    const { INTER_FONT_PATHS, resolveFontPath } = await loadModule();
    expect(INTER_FONT_PATHS.variable).toBe(resolveFontPath('InterVariable.ttf'));
    expect(INTER_FONT_PATHS.variableItalic).toBe(resolveFontPath('InterVariable-Italic.ttf'));
  });
});
