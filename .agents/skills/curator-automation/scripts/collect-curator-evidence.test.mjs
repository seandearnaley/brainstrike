import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'collect-curator-evidence.mjs'
);

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();
}

function write(repo, relativePath, content) {
  const file = path.join(repo, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function commitAll(repo, message) {
  run('git', ['add', '--all'], repo);
  run('git', ['commit', '-m', message], repo);
}

const MIGRATION = `
import type { Migration } from './migration-runner';

export const migration057Fixture: Migration = {
  up: \`
    INSERT INTO models
      (id, provider_id, name, sort_order, is_enabled)
    VALUES
      ('vendor/overlap', 'openrouter', 'Overlap', 1, false),
      ('vendor/repo-only', 'openrouter', 'Repo only', 2, false),
      ('native-model', 'openai', 'Native', 3, true)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO audit_events (id, provider_id)
    VALUES ('decoy/not-a-model', 'openrouter');
  \`,
  version: 57,
};
`;

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-collector-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  run('git', ['init', '--initial-branch=main'], repo);
  run('git', ['config', 'user.email', 'curator@example.test'], repo);
  run('git', ['config', 'user.name', 'Curator Test'], repo);
  write(repo, '.night-shift/PROTOCOL.md', '# Protocol\n');
  write(repo, 'packages/db/src/migrations/057-fixture.ts', MIGRATION);
  write(
    repo,
    'packages/db/src/migrations/058-shared-id.ts',
    `
export const migration058 = \`
  INSERT INTO models (id, provider_id, name)
  VALUES ('shared/model', 'transformers', 'Shared');
  INSERT INTO models (id, provider_id, name)
  VALUES ('shared/model', 'local', 'Shared');
\`;
`
  );
  write(
    repo,
    'packages/assistant-contract/src/provider-registry.ts',
    [
      "const registry = ['vendor/overlap', 'registry/only'];",
      "const notAModel = 'https://example.test/vendor/ignored';",
      '',
    ].join('\n')
  );
  commitAll(repo, 'fixture');

  const providersFile = path.join(root, 'providers.json');
  fs.writeFileSync(
    providersFile,
    JSON.stringify({
      data: [
        {
          context_length: 131_072,
          created: 2,
          id: 'vendor/new',
          name: 'New',
          pricing: { completion: '0.2', prompt: '0.1' },
        },
        {
          context_length: 65_536,
          created: 1,
          id: 'vendor/overlap',
          name: 'Overlap',
          pricing: { completion: '0.4', prompt: '0.3' },
        },
      ],
    })
  );
  return { providersFile, repo, root };
}

function collect(fixture) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT_PATH,
      '--repo',
      fixture.repo,
      '--revision',
      'HEAD',
      '--providers-json',
      fixture.providersFile,
    ],
    { encoding: 'utf8' }
  );
}

test('computes exact provider/repo deltas and a stable watched-set hash', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));

  const first = collect(fixture);
  const second = collect(fixture);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const evidence = JSON.parse(first.stdout);
  const repeated = JSON.parse(second.stdout);

  assert.equal(evidence.schema, 'collect-curator-evidence');
  assert.deepEqual(evidence.providerNotInRepo, [
    {
      contextLength: 131_072,
      created: 2,
      id: 'vendor/new',
      name: 'New',
      pricingCompletion: '0.2',
      pricingPrompt: '0.1',
    },
  ]);
  assert.deepEqual(evidence.repoNotInProvider, [
    {
      modelId: 'vendor/repo-only',
      providerId: 'openrouter',
      sources: ['packages/db/src/migrations/057-fixture.ts'],
    },
  ]);
  assert.ok(!evidence.repoSurface.some((entry) => entry.modelId === 'decoy/not-a-model'));
  assert.deepEqual(
    evidence.repoSurface
      .filter((entry) => entry.modelId === 'shared/model')
      .map((entry) => entry.providerId),
    ['local', 'transformers']
  );
  assert.deepEqual(
    evidence.repoSurface.find(
      (entry) => entry.modelId === 'vendor/overlap' && entry.providerId === 'openrouter'
    ),
    {
      modelId: 'vendor/overlap',
      providerId: 'openrouter',
      sources: [
        'packages/assistant-contract/src/provider-registry.ts',
        'packages/db/src/migrations/057-fixture.ts',
      ],
    }
  );
  const expectedHash = createHash('sha256')
    .update(['vendor/new', 'vendor/overlap', 'vendor/overlap', 'vendor/repo-only'].join('\n'))
    .digest('hex');
  assert.equal(evidence.watchedSetHash, expectedHash);
  assert.equal(repeated.watchedSetHash, evidence.watchedSetHash);
});

test('does not drop rows after a semicolon inside a SQL string literal', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));
  write(
    fixture.repo,
    'packages/db/src/migrations/059-semicolon-literal.ts',
    `
export const migration059 = \`
  INSERT INTO models (id, provider_id, name)
  VALUES
    ('vendor/semi', 'openrouter', 'Fast; cheap'),
    ('vendor/after-semi', 'openrouter', 'It''s here; still'),
    ('vendor/tail', 'openrouter', 'Tail row');
\`;
`
  );
  commitAll(fixture.repo, 'semicolon literal migration');

  const result = collect(fixture);
  assert.equal(result.status, 0, result.stderr);
  const surface = JSON.parse(result.stdout).repoSurface;
  for (const modelId of ['vendor/semi', 'vendor/after-semi', 'vendor/tail']) {
    assert.ok(
      surface.some((entry) => entry.modelId === modelId && entry.providerId === 'openrouter'),
      `expected ${modelId} to survive statement splitting`
    );
  }
});

test('fails closed when model migration extraction yields zero pairs', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));
  write(
    fixture.repo,
    'packages/db/src/migrations/057-fixture.ts',
    "export const migration = `INSERT INTO audit_events VALUES ('decoy/model', 'openrouter');`;\n"
  );
  write(
    fixture.repo,
    'packages/db/src/migrations/058-shared-id.ts',
    "export const migration = `INSERT INTO audit_events VALUES ('decoy/shared', 'local');`;\n"
  );
  commitAll(fixture.repo, 'remove model inserts');

  const result = collect(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /extraction yielded zero/u);
});

test('fails closed on malformed providers-json', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));
  fs.writeFileSync(fixture.providersFile, '{"data":');

  const result = collect(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^collect-curator-evidence: cannot parse --providers-json/mu);
});
