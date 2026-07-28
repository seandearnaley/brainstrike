import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const readSourceFile = (relativePath: string): string =>
  readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');

describe('Vite embedding worker entry contract', () => {
  it('keeps Vite worker asset resolution inside the owning package', () => {
    const viteEntry = readSourceFile('src/vite.ts');

    expect(viteEntry).toContain("from './embedding.worker.ts?worker&url'");
    expect(viteEntry).toContain('return embeddingWorkerUrlHref');
  });

  it('keeps the package entry on the built worker path for non-Vite runtimes', () => {
    const packageEntry = readSourceFile('src/worker-url.ts');

    expect(packageEntry).not.toContain('?worker');
    expect(packageEntry).toContain("new URL('./embedding.worker.js', import.meta.url)");
  });
});
