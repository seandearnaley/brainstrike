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
  ])('resolves %s to %s', (path, language, expectedLabel) => {
    expect(resolveCodeSurfaceLanguage({ path, language })?.label).toBe(expectedLabel);
  });

  it('prefers an explicit language hint over the filename extension', () => {
    expect(resolveCodeSurfaceLanguage({ path: 'notes.txt', language: 'markdown' })?.label).toBe(
      'Markdown'
    );
  });

  it('falls back to plaintext for unknown extensions', () => {
    expect(resolveCodeSurfaceLanguage({ path: 'archive.unknown-ext' })?.label).toBe('Plain Text');
  });
});
