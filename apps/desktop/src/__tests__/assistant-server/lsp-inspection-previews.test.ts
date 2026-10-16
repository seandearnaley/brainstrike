// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { toInspectLocations } from '@brainstrike/host-capabilities/native-tools';
import { afterEach, beforeEach, expect, it } from 'vitest';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'bs-lsp-preview-'));
  await writeFile(path.join(root, 'config.ts'), 'export const region = "us-east-1";\n');
  await writeFile(path.join(root, '.env.local.ts'), 'export const key = "sk-live-SECRET";\n');
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

// Codex review on #3718: lspInspect previews the line its definitions and
// implementations resolve to, which the language server may place in a
// credential file. The location stays; that file's line is never read.
it('previews an inspected target’s line, never a credential file’s', async () => {
  const at = (file: string) => ({
    range: { end: { character: 0, line: 0 }, start: { character: 0, line: 0 } },
    uri: pathToFileURL(path.join(root, file)).href,
  });
  const locations = await toInspectLocations([at('config.ts'), at('.env.local.ts')], root);
  expect(locations).toEqual([
    { line: 1, path: '/config.ts', preview: 'export const region = "us-east-1";' },
    { line: 1, path: '/.env.local.ts' },
  ]);
});
