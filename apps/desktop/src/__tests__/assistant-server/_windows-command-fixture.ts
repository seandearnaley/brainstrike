import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';

/** Source tests execute the actual bundled wrapper; packaged tests use the production resolver. */
export function builtWindowsCommandEntry(): string {
  const entry = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../dist/windows-command-entry.js'
  );
  if (!statSync(entry).isFile()) {
    throw new Error('Build Desktop main before running Windows command integration tests.');
  }
  return entry;
}

vi.mock('../../bundled-sibling-path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../bundled-sibling-path')>();
  return {
    ...actual,
    resolveBundledSiblingPath: (
      context: string,
      filename: string,
      currentModuleFilename?: string
    ): string =>
      actual.resolveBundledSiblingPath(
        context,
        filename,
        process.platform === 'win32' && filename === 'windows-command-entry.js'
          ? builtWindowsCommandEntry()
          : currentModuleFilename
      ),
  };
});
