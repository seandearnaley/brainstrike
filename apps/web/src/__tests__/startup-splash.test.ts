import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webIndexHtml = readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');
const desktopIndexHtml = readFileSync(
  path.resolve(__dirname, '../../../desktop/index.html'),
  'utf8'
);

function extractSplashStyle(html: string): string | null {
  const match = html.match(/<style>[\s\S]*?<\/style>/);
  return match?.[0].includes('.bs-startup-shell') ? normalize(match[0]) : null;
}

function extractRootMarkup(html: string): string | null {
  const match = html.match(/<div id="root">[\s\S]*?<\/div>\s*<script/);
  return match ? normalize(match[0].replace(/<script$/, '')) : null;
}

function normalize(fragment: string): string {
  return fragment.replaceAll(/\s+/g, ' ').trim();
}

/**
 * The pre-React startup splash must exist on BOTH apps: it is inline
 * HTML/CSS painted before any JS executes, so the user never sees a blank
 * white page while the bundle loads. Desktop and web share the same markup;
 * this test pins the parity so an edit to one file can't silently drift.
 */
describe('startup splash', () => {
  it('web index.html renders the inline startup splash inside #root', () => {
    expect(webIndexHtml).toContain('bs-startup-shell');
    expect(webIndexHtml).toContain('bs-startup-progress');
    expect(extractSplashStyle(webIndexHtml)).not.toBeNull();
    expect(extractRootMarkup(webIndexHtml)).toContain('class="bs-startup-shell"');
  });

  it('desktop index.html renders the inline startup splash inside #root', () => {
    expect(desktopIndexHtml).toContain('bs-startup-shell');
    expect(extractSplashStyle(desktopIndexHtml)).not.toBeNull();
    expect(extractRootMarkup(desktopIndexHtml)).toContain('class="bs-startup-shell"');
  });

  it('web and desktop splash style and markup stay in sync', () => {
    expect(extractSplashStyle(webIndexHtml)).toBe(extractSplashStyle(desktopIndexHtml));
    expect(extractRootMarkup(webIndexHtml)).toBe(extractRootMarkup(desktopIndexHtml));
  });
});
