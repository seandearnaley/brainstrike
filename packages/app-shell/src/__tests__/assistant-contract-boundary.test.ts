import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP_SHELL_PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);

// assistant-data's own boundary suite (contract-boundary.test.ts there) now
// owns the moved data layer's import hygiene; this file guards app-shell only.
describe('app-shell assistant contract boundary', () => {
  it('has no direct app-shell dependency on the agent runtime package', () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(APP_SHELL_PACKAGE_ROOT, 'package.json'), 'utf8')
    ) as { dependencies?: Record<string, string> };

    expect(packageJson.dependencies).not.toHaveProperty('@brainstrike/agent');
  });
});
