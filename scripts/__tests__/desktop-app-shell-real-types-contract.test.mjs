/**
 * BST-1155: desktop consumes @brainstrike/app-shell through the package's own
 * declarations. An ambient `declare module '@brainstrike/app-shell…'` in desktop
 * only re-declares what the package exports: under the repo-wide skipLibCheck it is
 * inert, and with skipLibCheck off it conflicts with the real declarations (the
 * removed app-shell-shims.d.ts reported 24 TS2451/TS2687/TS2717/TS2300 errors).
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { it } from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const desktopSource = path.join(repoRoot, 'apps/desktop/src');
const ambientAppShell = /declare\s+module\s+['"]@brainstrike\/app-shell(?:\/[^'"]*)?['"]/u;

async function typeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return entry.name === 'node_modules' ? [] : typeScriptFiles(entryPath);
      }
      return /\.(?:d\.)?tsx?$/u.test(entry.name) ? [entryPath] : [];
    })
  );
  return nested.flat();
}

it('desktop declares no ambient @brainstrike/app-shell module: the package types are the only ones', async () => {
  const offenders = [];
  for (const file of await typeScriptFiles(desktopSource)) {
    if (ambientAppShell.test(await readFile(file, 'utf8'))) {
      offenders.push(path.relative(repoRoot, file));
    }
  }
  assert.deepEqual(offenders, []);
});
