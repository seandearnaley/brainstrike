import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findAssistantRunIdProducerViolations } from '../assistant-run-id-producer-guard.mjs';

const OWNING_FILE = 'packages/app-shell/src/assistant-ui-panel-wrapper-runtime.ts';

// Guard: the desktop main process writes into bootstrap-only relations
// (brainstrike_assistant_run_events / _thread_runs). Those writes are safe only
// because a single producer mints `memory.runId` behind the schema bootstrap.
// See docs/agents/assistant-persistence.md
// § RUN-EVENT / THREAD-RUN SCHEMA OWNERSHIP.
test('real tree: exactly one runId producer, declared and called in the owning module', async () => {
  const { callCount, declarationCount, violations } = await findAssistantRunIdProducerViolations();
  assert.equal(declarationCount, 1);
  assert.equal(callCount, 1);
  assert.deepEqual(
    violations,
    [],
    violations.map((v) => `  - ${v.filePath}:${v.lineNumber} — ${v.reason}`).join('\n')
  );
});

async function writeFixture(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'run-id-producer-guard-'));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, contents);
  }
  return root;
}

const COMPLIANT_OWNER = `function createThreadRunId(): string {
  return crypto.randomUUID();
}
export function createAssistantThreadRunPromise() {
  const runId = createThreadRunId();
  return runId;
}
`;

test('accepts the compliant single-producer shape', async () => {
  const root = await writeFixture({ [OWNING_FILE]: COMPLIANT_OWNER });
  const { callCount, declarationCount, violations } = await findAssistantRunIdProducerViolations({
    root,
  });
  assert.equal(declarationCount, 1);
  assert.equal(callCount, 1);
  assert.deepEqual(violations, []);
});

test('flags a second producer declared in another module', async () => {
  const root = await writeFixture({
    [OWNING_FILE]: COMPLIANT_OWNER,
    'apps/desktop/src/background-run.ts': `function createThreadRunId(): string {
  return 'run-bg';
}
const id = createThreadRunId();
`,
  });

  const { violations } = await findAssistantRunIdProducerViolations({ root });
  const reasons = violations.map((v) => v.reason);
  assert.ok(reasons.some((r) => r.includes('declared only in')));
  assert.ok(reasons.some((r) => r.includes('called only in')));
  assert.ok(reasons.some((r) => r.includes('found 2')));
});

test('flags a second call site even inside the owning module', async () => {
  const root = await writeFixture({
    [OWNING_FILE]: `${COMPLIANT_OWNER}
export function resumeRun() {
  return createThreadRunId();
}
`,
  });

  const { callCount, violations } = await findAssistantRunIdProducerViolations({ root });
  assert.equal(callCount, 2);
  assert.ok(violations.some((v) => v.reason.includes('exactly 1 call site')));
});

test('flags exporting the producer (another module could then mint an id)', async () => {
  const root = await writeFixture({
    [OWNING_FILE]: `export function createThreadRunId(): string {
  return crypto.randomUUID();
}
const runId = createThreadRunId();
`,
  });

  const { violations } = await findAssistantRunIdProducerViolations({ root });
  assert.ok(violations.some((v) => v.reason.includes('module-private')));
});

test('flags exporting the private producer through an export specifier', async () => {
  const root = await writeFixture({
    [OWNING_FILE]: `${COMPLIANT_OWNER}
export { createThreadRunId };
`,
  });

  const { violations } = await findAssistantRunIdProducerViolations({ root });
  assert.ok(violations.some((violation) => violation.reason.includes('module-private')));
});

test('flags property-access and constructor references to the producer', async () => {
  const root = await writeFixture({
    [OWNING_FILE]: COMPLIANT_OWNER,
    'apps/desktop/src/background-run.ts': `runtime.createThreadRunId();
new createThreadRunId();
`,
  });

  const { callCount, violations } = await findAssistantRunIdProducerViolations({ root });
  assert.equal(callCount, 3);
  assert.ok(violations.some((violation) => violation.reason.includes('called only in')));
  assert.ok(violations.some((violation) => violation.reason.includes('found 3')));
});

test('flags a named producer function expression as a second declaration', async () => {
  const root = await writeFixture({
    [OWNING_FILE]: COMPLIANT_OWNER,
    'apps/desktop/src/background-run.ts':
      'const mint = function createThreadRunId() { return crypto.randomUUID(); };\n',
  });

  const { declarationCount, violations } = await findAssistantRunIdProducerViolations({ root });
  assert.equal(declarationCount, 2);
  assert.ok(violations.some((violation) => violation.reason.includes('declared only in')));
});

test('ignores tests and build output', async () => {
  const root = await writeFixture({
    [OWNING_FILE]: COMPLIANT_OWNER,
    'packages/app-shell/dist/bundle.js': 'function createThreadRunId(){return 1}\n',
    'packages/app-shell/src/__tests__/runtime.test.ts': 'createThreadRunId();\n',
  });

  const { callCount, declarationCount, violations } = await findAssistantRunIdProducerViolations({
    root,
  });
  assert.equal(declarationCount, 1);
  assert.equal(callCount, 1);
  assert.deepEqual(violations, []);
});

test('ignores producer-shaped text in comments and literals', async () => {
  const root = await writeFixture({
    [OWNING_FILE]: COMPLIANT_OWNER,
    'packages/assistant-ui/src/run-event-derivation.ts': `
// createThreadRunId() is intentionally owned by app-shell.
/** Keep createThreadRunId() behind the schema bootstrap. */
const singleQuoted = 'createThreadRunId()';
const doubleQuoted = "createThreadRunId()";
const templateText = \`createThreadRunId()\`;
const pattern = /createThreadRunId\\(\\)/;
`,
  });

  const { callCount, declarationCount, violations } = await findAssistantRunIdProducerViolations({
    root,
  });

  assert.equal(declarationCount, 1);
  assert.equal(callCount, 1);
  assert.deepEqual(violations, []);
});

test('fails closed when producer-bearing source cannot be parsed', async () => {
  const root = await writeFixture({
    [OWNING_FILE]: COMPLIANT_OWNER,
    'packages/assistant-ui/src/run-event-derivation.ts':
      'const broken = `createThreadRunId() is unterminated;\n',
  });

  await assert.rejects(
    findAssistantRunIdProducerViolations({ root }),
    /could not be parsed, so runId provenance cannot be verified/u
  );
});
