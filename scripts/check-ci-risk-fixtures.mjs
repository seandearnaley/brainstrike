#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { E2E_LANES } from './ci-select.mjs';
import {
  selectLocalCommandNamesForFiles,
  selectRiskLanesForFiles,
  selectRiskProfileForFiles,
} from './ci-risk-rules.mjs';

const DEFAULT_FIXTURES_PATH = 'scripts/ci-risk-fixtures.json';

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareArray(name, actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) {
    return [`${name} must be an array`];
  }
  if (actual.length !== expected.length) {
    return [`${name} length differs: expected ${expected.length}, got ${actual.length}`];
  }
  const failures = [];
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) {
      failures.push(`${name}[${index}] differs: expected ${expected[index]}, got ${actual[index]}`);
    }
  }
  return failures;
}

function validateRegisteredE2eLanes(name, lanes) {
  if (!Array.isArray(lanes)) {
    return [];
  }
  const failures = [];
  for (let index = 0; index < lanes.length; index += 1) {
    const lane = lanes[index];
    if (!E2E_LANES[lane]) {
      failures.push(`${name}[${index}] is not registered: ${lane}`);
    }
  }
  return failures;
}

function validateFixture(fixture) {
  const failures = [];
  if (!isObject(fixture)) {
    return ['fixture must be an object'];
  }
  if (typeof fixture.name !== 'string' || fixture.name.length === 0) {
    failures.push('fixture name must be a non-empty string');
  }
  if (!Array.isArray(fixture.files) || fixture.files.length === 0) {
    failures.push(`${fixture.name ?? '<unknown>'} files must be a non-empty array`);
  }
  if (!isObject(fixture.expected)) {
    failures.push(`${fixture.name ?? '<unknown>'} expected must be an object`);
  }
  return failures;
}

export function verifyRiskFixtures(fixtureDocument) {
  const failures = [];
  if (!isObject(fixtureDocument)) {
    return ['risk fixture document must be an object'];
  }
  if (fixtureDocument.schemaVersion !== 1) {
    failures.push('schemaVersion must be 1');
  }
  if (!Array.isArray(fixtureDocument.cases)) {
    failures.push('cases must be an array');
    return failures;
  }
  if (fixtureDocument.cases.length < 10) {
    failures.push(`at least 10 representative cases are required; found ${fixtureDocument.cases.length}`);
  }
  const names = new Set();
  for (const fixture of fixtureDocument.cases) {
    const fixtureFailures = validateFixture(fixture);
    if (fixtureFailures.length > 0) {
      failures.push(...fixtureFailures);
      continue;
    }
    if (names.has(fixture.name)) {
      failures.push(`duplicate fixture name ${fixture.name}`);
    }
    names.add(fixture.name);
    const actual = selectRiskProfileForFiles(fixture.files);
    const actualCloudLanes = selectRiskLanesForFiles(fixture.files);
    const actualLocalCommandNames = selectLocalCommandNamesForFiles(fixture.files);
    const expected = fixture.expected;
    if (actual.category !== expected.category) {
      failures.push(`${fixture.name} category differs: expected ${expected.category}, got ${actual.category}`);
    }
    failures.push(...compareArray(`${fixture.name} cloudLanes`, actualCloudLanes, expected.cloudLanes));
    failures.push(...validateRegisteredE2eLanes(`${fixture.name} expected e2eLanes`, expected.e2eLanes));
    failures.push(...validateRegisteredE2eLanes(`${fixture.name} actual e2eLanes`, actual.e2eLanes));
    failures.push(...compareArray(`${fixture.name} e2eLanes`, actual.e2eLanes, expected.e2eLanes));
    failures.push(...compareArray(`${fixture.name} localCommandNames`, actualLocalCommandNames, expected.localCommandNames));
  }
  return failures;
}

function readFlagValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export async function runCli(args = process.argv.slice(2)) {
  let fixturesPath;
  try {
    fixturesPath = readFlagValue(args, '--fixtures') ?? DEFAULT_FIXTURES_PATH;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  let fixtureDocument;
  try {
    fixtureDocument = JSON.parse(await readFile(fixturesPath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`failed to read ${fixturesPath}: ${message}`);
    return 1;
  }
  const failures = verifyRiskFixtures(fixtureDocument);
  if (failures.length > 0) {
    console.error(`CI risk fixture check failed:\n${failures.join('\n')}`);
    return 1;
  }
  console.log(`CI risk fixture check passed: ${fixtureDocument.cases.length} representative cases.`);
  return 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === modulePath) {
  const exitCode = await runCli();
  process.exit(exitCode);
}
