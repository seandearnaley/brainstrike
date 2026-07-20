import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findBrowserEventLiteralViolations } from '../browser-events-literal-guard.mjs';

// Built via join so this test file is not itself a guarded literal.
const drainedEvent = ['brainstrike', 'queue-drained'].join(':');
const progressEvent = ['brainstrike', 'queue-progress'].join(':');
const updatedEvent = ['brainstrike', 'embedding-set-updated'].join(':');

// Guard: the queue/embedding-set CustomEvent names are a cross-package wire
// contract owned by packages/utils/src/browser-events.ts (BST-580). Any stray
// literal outside that module (+ its unit test) can silently drift the detail
// shape again, so the real tree must stay clean.
test('real tree: no guarded event literals outside the shared module', async () => {
  const violations = await findBrowserEventLiteralViolations();
  assert.deepEqual(
    violations,
    [],
    'Import constants/helpers from @brainstrike/utils/browser-events instead of ' +
      'spelling event names:\n' +
      violations.map((v) => `  - ${v.filePath}:${v.lineNumber} (${v.eventName})`).join('\n')
  );
});

async function writeFixture(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'browser-events-guard-'));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, contents);
  }
  return root;
}

test('flags each guarded literal outside the allowlist with file and line', async () => {
  const root = await writeFixture({
    'packages/example/src/thing.ts': `const name = '${drainedEvent}';\nconst other = '${updatedEvent}';\n`,
    'scripts/example.mjs': `console.log('${progressEvent}');\n`,
  });

  const violations = await findBrowserEventLiteralViolations({ root });
  assert.deepEqual(violations, [
    { eventName: drainedEvent, filePath: 'packages/example/src/thing.ts', lineNumber: 1 },
    { eventName: updatedEvent, filePath: 'packages/example/src/thing.ts', lineNumber: 2 },
    { eventName: progressEvent, filePath: 'scripts/example.mjs', lineNumber: 1 },
  ]);
});

test('permits the shared module, its unit test, and non-source files', async () => {
  const root = await writeFixture({
    'packages/example/README.md': `docs may mention ${drainedEvent}\n`,
    'packages/utils/src/__tests__/browser-events.test.ts': `expect(QUEUE_DRAINED_EVENT).toBe('${drainedEvent}');\n`,
    'packages/utils/src/browser-events.ts': `export const QUEUE_DRAINED_EVENT = '${drainedEvent}' as const;\n`,
  });

  const violations = await findBrowserEventLiteralViolations({ root });
  assert.deepEqual(violations, []);
});

test('ignores generated output directories', async () => {
  const root = await writeFixture({
    'packages/example/dist/bundle.js': `const name = '${drainedEvent}';\n`,
  });

  const violations = await findBrowserEventLiteralViolations({ root });
  assert.deepEqual(violations, []);
});
