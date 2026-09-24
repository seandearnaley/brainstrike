import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findAssistantRunIdProducerViolations } from '../assistant-run-id-producer-guard.mjs';

const OWNING_FILE = 'packages/app-shell/src/assistant-ui-panel-wrapper-runtime.ts';

// Guard: the desktop main process writes run events keyed by `memory.runId`,
// assuming its brainstrike_assistant_thread_runs row exists. That holds only
// because a single producer mints `memory.runId` and creates the row with it.
// See docs/agents/assistant-persistence.md
// § RUN-EVENT / THREAD-RUN SCHEMA OWNERSHIP.
test('real tree: exactly one runId producer, declared and called in the owning module', async () => {
  const { brandConstructionCount, callCount, declarationCount, violations } =
    await findAssistantRunIdProducerViolations();
  assert.equal(declarationCount, 1);
  assert.equal(callCount, 1);
  assert.equal(brandConstructionCount, 1);
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

const COMPLIANT_OWNER = `function createThreadRunId(): HostRunId {
  return \`run-\${crypto.randomUUID()}\` as HostRunId;
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
    'packages/assistant-data/src/__tests__/runs.integration.test.ts':
      "const id = 'run-1' as HostRunId;\n",
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

const BRAND_ASSERTED_ONLY_IN_PRODUCER = 'may be asserted only inside createThreadRunId';

test('accepts the brand named in annotations and generic positions that do not assert', async () => {
  const root = await writeFixture({
    [OWNING_FILE]: COMPLIANT_OWNER,
    'packages/assistant-data/src/runs.ts': `import type { HostRunId } from './host-run-id';
export interface Input { readonly id: HostRunId }
export function create(input: Input): Promise<HostRunId> { return Promise.resolve(input.id); }
const ids: Map<string, HostRunId> = new Map();
`,
  });

  const { brandConstructionCount, violations } = await findAssistantRunIdProducerViolations({
    root,
  });
  assert.equal(brandConstructionCount, 1);
  assert.deepEqual(violations, []);
});

test('flags every way another module can assert the brand', async () => {
  const root = await writeFixture({
    [OWNING_FILE]: COMPLIANT_OWNER,
    'apps/desktop/src/background-run.ts': `const a = crypto.randomUUID() as HostRunId;
const b = <HostRunId>crypto.randomUUID();
const c = 'run-x' as unknown as HostRunId;
const d = JSON.parse(body) as { readonly id: HostRunId };
const e = raw as import('@brainstrike/assistant-contract/host-run-id').HostRunId;
const f = raw as contract.HostRunId;
`,
  });

  const { brandConstructionCount, violations } = await findAssistantRunIdProducerViolations({
    root,
  });
  assert.equal(brandConstructionCount, 1);
  assert.deepEqual(
    violations
      .filter((violation) => violation.reason.includes(BRAND_ASSERTED_ONLY_IN_PRODUCER))
      .map((violation) => violation.lineNumber),
    [1, 2, 3, 4, 5, 6]
  );
});

test('flags a brand minted through a type argument', async () => {
  const root = await writeFixture({
    [OWNING_FILE]: COMPLIANT_OWNER,
    'apps/desktop/src/background-run.ts': `const mint = Brand.nominal<HostRunId>();
const cast = unsafeCast<HostRunId>('run-x');
`,
  });

  const { violations } = await findAssistantRunIdProducerViolations({ root });
  assert.deepEqual(
    violations
      .filter((violation) => violation.reason.includes(BRAND_ASSERTED_ONLY_IN_PRODUCER))
      .map((violation) => violation.lineNumber),
    [1, 2]
  );
});

test('flags a brand assertion in the owning module outside the producer', async () => {
  const root = await writeFixture({
    [OWNING_FILE]: `${COMPLIANT_OWNER}
export function forge(raw: string) {
  return raw as HostRunId;
}
`,
  });

  const { brandConstructionCount, violations } = await findAssistantRunIdProducerViolations({
    root,
  });
  assert.equal(brandConstructionCount, 1);
  assert.ok(
    violations.some(
      (violation) =>
        violation.filePath === OWNING_FILE &&
        violation.reason.includes(BRAND_ASSERTED_ONLY_IN_PRODUCER)
    )
  );
});

test('requires exactly one brand construction inside the producer', async () => {
  const unbranded = await writeFixture({
    [OWNING_FILE]: COMPLIANT_OWNER.replace(' as HostRunId', ''),
  });
  const twice = await writeFixture({
    [OWNING_FILE]: COMPLIANT_OWNER.replace(
      ' as HostRunId;',
      ' as HostRunId;\n  void (crypto.randomUUID() as HostRunId);'
    ),
  });

  const missing = await findAssistantRunIdProducerViolations({ root: unbranded });
  assert.equal(missing.brandConstructionCount, 0);
  assert.ok(missing.violations.some((violation) => violation.reason.includes('found 0')));

  const doubled = await findAssistantRunIdProducerViolations({ root: twice });
  assert.equal(doubled.brandConstructionCount, 2);
  assert.ok(doubled.violations.some((violation) => violation.reason.includes('found 2')));
});

test('flags renaming the brand on import or export', async () => {
  const root = await writeFixture({
    [OWNING_FILE]: COMPLIANT_OWNER,
    'apps/desktop/src/background-run.ts': `import type { HostRunId as RunId } from '@brainstrike/assistant-contract/host-run-id';
export type { HostRunId as MintedRunId } from '@brainstrike/assistant-contract/host-run-id';
`,
  });

  const { violations } = await findAssistantRunIdProducerViolations({ root });
  assert.deepEqual(
    violations
      .filter((violation) => violation.reason.includes('must not be renamed'))
      .map((violation) => violation.lineNumber),
    [1, 2]
  );
});
