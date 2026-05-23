import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const readSourceFile = (relativePath: string): string =>
  readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');

describe('Vite file tree worker entry contract', () => {
  it('keeps the renderer entry on Vite worker asset resolution', () => {
    const viteEntry = readSourceFile('src/vite.ts');

    expect(viteEntry).toContain("from './file-tree.worker.ts?worker&url'");
    expect(viteEntry).toContain('return new URL(fileTreeWorkerUrlHref, import.meta.url)');
  });

  it('keeps the package entry on the built worker path for non-Vite runtimes', () => {
    const packageEntry = readSourceFile('src/index.ts');

    expect(packageEntry).not.toContain('?worker');
    expect(packageEntry).toContain("new URL('./file-tree.worker.js', import.meta.url)");
  });
});
