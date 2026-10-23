import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readHiddenPreloadSource(): string {
  return readFileSync(path.resolve(process.cwd(), 'src', 'hidden-preload.ts'), 'utf8');
}

describe('hidden renderer preload contract', () => {
  it('contains explicit capability manifests for every hidden renderer role', () => {
    const source = readHiddenPreloadSource();

    expect(source).toContain("'embedding-host'");
    expect(source).toContain('brainstrike-hidden-renderer-role');
  });

  it('cannot expose provider secrets', () => {
    const source = readHiddenPreloadSource();

    expect(source).not.toMatch(/exposeInMainWorld\(['"]secrets['"]/);
    expect(source).not.toContain('secrets:get');
  });

  it('cannot expose the env bootstrap bridge (BST-1363: visible-ui settings surface only)', () => {
    const source = readHiddenPreloadSource();

    expect(source).not.toMatch(/exposeInMainWorld\(['"]envBootstrap['"]/);
    expect(source).not.toContain('secrets:envBootstrap');
  });

  it('cannot expose the unrestricted key-value storage bridge (BST-1380: scoped vector preferences only)', () => {
    const source = readHiddenPreloadSource();

    expect(source).not.toContain('storage:getItem');
    expect(source).not.toContain('storage:setItem');
    expect(source).not.toContain('storage:getAllKeys');
    expect(source).not.toContain('storage:clear');
  });
});
