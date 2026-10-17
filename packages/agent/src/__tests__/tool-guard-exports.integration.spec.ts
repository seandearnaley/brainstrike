import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('shares deadline ownership across the actual ESM/CJS and MCP package exports', async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/tool-guard-export-proof.mjs', import.meta.url))],
    { timeout: 15_000 }
  );
  expect(stdout).toContain(
    'PASS: ESM/CJS root, tool-runtime and MCP exports share deadline ownership.'
  );
});
