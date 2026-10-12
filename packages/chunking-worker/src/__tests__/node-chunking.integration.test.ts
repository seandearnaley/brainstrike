import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('loads the public built canonical Node export with no renderer or source alias', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../../test/node-chunking-smoke.mjs', import.meta.url)),
  ]);
  expect(stdout).toContain('"canonicalParity":true');
});
