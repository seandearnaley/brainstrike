import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP_SHELL_SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(APP_SHELL_SRC_ROOT, relativePath), 'utf8');
}

describe('app-shell indexing contract boundary', () => {
  it('keeps background indexing provider metadata behind indexing-contract', () => {
    const serviceSource = readSource('background-indexing/workspace-collection-sync-service.ts');

    expect(serviceSource).not.toMatch(/@brainstrike\/embeddings\/provider-core/);
  });
});
