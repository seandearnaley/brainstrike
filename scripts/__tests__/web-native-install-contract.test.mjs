import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflows = [
  '.github/workflows/test.yml',
  '.github/workflows/web-e2e.yml',
  '.github/workflows/performance.yml',
];

test('toolchain-less web workflows exclude desktop native packages', () => {
  for (const workflow of workflows) {
    const source = readFileSync(workflow, 'utf8');
    const install = source
      .split('\n')
      .find(
        (line) =>
          line.includes('pnpm install --frozen-lockfile') && line.includes('!@brainstrike/desktop')
      );
    assert.match(install ?? '', /--filter '!@brainstrike\/desktop'/, workflow);
    assert.match(install ?? '', /--filter '!@brainstrike\/secure-fs-native'/, workflow);
  }
});
