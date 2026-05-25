import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  runCli,
  verifyRiskFixtures,
} from '../check-ci-risk-fixtures.mjs';
import riskFixtures from '../ci-risk-fixtures.json' with { type: 'json' };

test('committed risk fixtures verify at least 10 representative change cases', () => {
  assert.equal(verifyRiskFixtures(riskFixtures).length, 0);
  assert.ok(riskFixtures.cases.length >= 10);
});

test('verifyRiskFixtures rejects an under-specified representative set', () => {
  const fixtureDocument = {
    schemaVersion: 1,
    cases: riskFixtures.cases.slice(0, 9),
  };

  assert.deepEqual(verifyRiskFixtures(fixtureDocument), [
    'at least 10 representative cases are required; found 9',
  ]);
});

test('verifyRiskFixtures reports deterministic lane mismatches', () => {
  const fixtureDocument = {
    schemaVersion: 1,
    cases: [
      {
        ...riskFixtures.cases[0],
        expected: {
          ...riskFixtures.cases[0].expected,
          category: 'full-release-high-risk',
          cloudLanes: ['ci:full'],
        },
      },
      ...riskFixtures.cases.slice(1),
    ],
  };

  assert.deepEqual(verifyRiskFixtures(fixtureDocument), [
    'docs-only report category differs: expected full-release-high-risk, got docs-only',
    'docs-only report cloudLanes length differs: expected 1, got 0',
  ]);
});

test('verifyRiskFixtures rejects unregistered expected E2E lane names', () => {
  const assistantFixtureIndex = riskFixtures.cases.findIndex(
    (fixture) => fixture.name === 'assistant contract'
  );
  assert.notEqual(assistantFixtureIndex, -1);
  const fixtureCases = riskFixtures.cases.map((fixture, index) =>
    index === assistantFixtureIndex
      ? {
          ...fixture,
          expected: {
            ...fixture.expected,
            e2eLanes: ['web-functional-stateful'],
          },
        }
      : fixture
  );
  const fixtureDocument = {
    schemaVersion: 1,
    cases: fixtureCases,
  };

  assert.deepEqual(verifyRiskFixtures(fixtureDocument), [
    'assistant contract expected e2eLanes[0] is not registered: web-functional-stateful',
    'assistant contract e2eLanes[0] differs: expected web-functional-stateful, got web-assistant-state',
  ]);
});

test('verifyRiskFixtures rejects duplicate fixture names', () => {
  const fixtureDocument = {
    schemaVersion: 1,
    cases: [
      riskFixtures.cases[0],
      { ...riskFixtures.cases[1], name: riskFixtures.cases[0].name },
      ...riskFixtures.cases.slice(2),
    ],
  };

  assert.deepEqual(verifyRiskFixtures(fixtureDocument), [
    `duplicate fixture name ${riskFixtures.cases[0].name}`,
  ]);
});

test('runCli checks the committed fixture file successfully', async () => {
  const originalConsoleLog = console.log;
  const logs = [];
  console.log = (message) => logs.push(String(message));
  try {
    const exitCode = await runCli([]);

    assert.equal(exitCode, 0);
    assert.match(logs.join('\n'), /CI risk fixture check passed: 30 representative cases\./);
  } finally {
    console.log = originalConsoleLog;
  }
});

test('runCli fails closed when --fixtures has no value', async () => {
  const originalConsoleError = console.error;
  const errors = [];
  console.error = (message) => errors.push(String(message));
  try {
    const exitCode = await runCli(['--fixtures']);

    assert.equal(exitCode, 1);
    assert.match(errors.join('\n'), /--fixtures requires a value/);
  } finally {
    console.error = originalConsoleError;
  }
});

test('runCli reports fixture mismatches from an explicit fixture path', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'brainstrike-risk-fixtures-'));
  const originalConsoleError = console.error;
  const errors = [];
  console.error = (message) => errors.push(String(message));
  try {
    const fixturesPath = path.join(dir, 'risk-fixtures.json');
    await writeFile(
      fixturesPath,
      JSON.stringify({
        schemaVersion: 1,
        cases: [
          {
            ...riskFixtures.cases[0],
            expected: {
              ...riskFixtures.cases[0].expected,
              e2eLanes: ['web-functional-stateful'],
            },
          },
          ...riskFixtures.cases.slice(1),
        ],
      })
    );

    const exitCode = await runCli(['--fixtures', fixturesPath]);

    assert.equal(exitCode, 1);
    assert.match(
      errors.join('\n'),
      /docs-only report e2eLanes length differs: expected 1, got 0/
    );
  } finally {
    console.error = originalConsoleError;
    await rm(dir, { force: true, recursive: true });
  }
});
