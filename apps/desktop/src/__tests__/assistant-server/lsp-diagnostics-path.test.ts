import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveBundledTsserverPath } from '../../assistant-server/lsp-diagnostics';

describe('bundled TypeScript server path', () => {
  const wrapperEntry = path.join(
    path.sep,
    'bundle',
    '@typescript',
    'typescript6',
    'lib',
    'typescript.js'
  );
  const wrapperServer = path.join(path.dirname(wrapperEntry), 'tsserver.js');
  const compatibilityEntry = path.join(path.sep, 'bundle', 'typescript', 'lib', 'typescript.js');
  const compatibilityServer = path.join(path.dirname(compatibilityEntry), 'tsserver.js');
  const resolveModule = (id: string, options?: { paths?: string[] }): string => {
    if (id === 'typescript') {
      return wrapperEntry;
    }
    if (id === '@typescript/old') {
      expect(options?.paths).toEqual([path.dirname(wrapperEntry)]);
      return compatibilityEntry;
    }
    throw new Error(`Unexpected module resolution: ${id}`);
  };

  it('uses an adjacent server when a conventional TypeScript package provides one', () => {
    expect(
      resolveBundledTsserverPath(resolveModule, (candidate) => candidate === wrapperServer)
    ).toBe(wrapperServer);
  });

  it('follows the TypeScript 6 compatibility wrapper to its real server', () => {
    expect(
      resolveBundledTsserverPath(resolveModule, (candidate) => candidate === compatibilityServer)
    ).toBe(compatibilityServer);
  });

  it('money test: an absent forwarded server reports its attributable path', () => {
    expect(() => resolveBundledTsserverPath(resolveModule, () => false)).toThrow(
      /Bundled TypeScript server is missing at .*typescript.*lib.*tsserver\.js/u
    );
  });
});
