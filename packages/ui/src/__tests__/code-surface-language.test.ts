// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolveCodeSurfaceLanguage } from '../code-surface/language';

describe('resolveCodeSurfaceLanguage', () => {
  it.each([
    ['src/app.ts', undefined, 'TypeScript'],
    ['src/app.tsx', undefined, 'TSX'],
    ['src/app.jsx', undefined, 'JSX'],
    ['src/config.json', undefined, 'JSON'],
    ['README.md', undefined, 'Markdown'],
    ['src/layout.xml', undefined, 'XML'],
    ['docker-compose.yaml', undefined, 'YAML'],
    ['scripts/setup.sh', undefined, 'Shell'],
    ['src/main.py', undefined, 'Python'],
    ['src/query.sql', undefined, 'SQL'],
    ['src/lib.rs', undefined, 'Rust'],
    ['src/main.go', undefined, 'Go'],
    ['src/App.java', undefined, 'Java'],
    ['src/native.cpp', undefined, 'C++'],
    ['src/Program.cs', undefined, 'C#'],
    ['src/index.php', undefined, 'PHP'],
    ['src/app.rb', undefined, 'Ruby'],
    ['src/App.swift', undefined, 'Swift'],
    ['src/Main.kt', undefined, 'Kotlin'],
    // Web-standard extensions (added in follow-up to bridge the gap that
    // forced unlabeled web files to render without highlighting).
    ['src/styles.css', undefined, 'CSS'],
    ['index.html', undefined, 'HTML'],
    ['legacy.htm', undefined, 'HTML'],
    ['src/styles.scss', undefined, 'SCSS'],
    ['src/styles.sass', undefined, 'Sass'],
    ['src/styles.less', undefined, 'Less'],
    ['src/App.vue', undefined, 'Vue'],
    ['src/App.svelte', undefined, 'Svelte'],
    ['Cargo.toml', undefined, 'TOML'],
    ['src/lib.lua', undefined, 'Lua'],
    ['src/native.c', undefined, 'C'],
    ['src/native.h', undefined, 'C'],
    ['src/main.dart', undefined, 'Dart'],
  ])('resolves %s to %s', (path, language, expectedLabel) => {
    expect(resolveCodeSurfaceLanguage({ language, path })?.label).toBe(expectedLabel);
  });

  it('prefers an explicit language hint over the filename extension', () => {
    expect(resolveCodeSurfaceLanguage({ language: 'markdown', path: 'notes.txt' })?.label).toBe(
      'Markdown'
    );
  });

  it('falls back to plaintext for unknown extensions', () => {
    expect(resolveCodeSurfaceLanguage({ path: 'archive.unknown-ext' })?.label).toBe('Plain Text');
  });

  it('still attempts loadSupport for unlabeled extensions so CodeMirror can try matchFilename', () => {
    // Filename is present and recognizable enough that we should give
    // CodeMirror's matchFilename a chance to load grammar — even though
    // our curated label map doesn't know the extension. The label
    // gracefully degrades to "Plain Text" but loadSupport remains a
    // function (not null), so highlighting can still load if the
    // registry has a match.
    const resolution = resolveCodeSurfaceLanguage({ path: 'src/exotic.someotherlang' });
    expect(resolution.label).toBe('Plain Text');
    expect(typeof resolution.loadSupport).toBe('function');
    expect(resolution.source).toBe('filename');
  });
});
