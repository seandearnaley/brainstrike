import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const contractPath = new URL('../../docs/diagnostics-privacy-contract.md', import.meta.url);
let contractSource = '';
let contractReadError = null;

try {
  contractSource = await readFile(contractPath, 'utf8');
} catch (error) {
  contractReadError = error;
}

test('diagnostics privacy contract exists in the repo docs', () => {
  assert.equal(contractReadError, null, `${contractPath.pathname} should exist`);
});

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const assertContractIncludes = (term, flags = 'i') => {
  assert.match(contractSource, new RegExp(escapeRegExp(term), flags));
};

const contractSection = (heading) => {
  const escapedHeading = escapeRegExp(heading);
  const sectionPattern = new RegExp(
    `^## ${escapedHeading}\\n(?<body>[\\s\\S]*?)(?=^## |$(?![\\s\\S]))`,
    'm'
  );
  const match = contractSource.match(sectionPattern);
  assert.ok(match?.groups?.body, `${heading} section should exist`);
  return match.groups.body;
};

const assertSectionIncludes = (section, term, flags = 'i') => {
  assert.match(section, new RegExp(escapeRegExp(term), flags));
};

const testWithContract = (name, callback) => {
  test(name, (context) => {
    if (contractReadError !== null) {
      context.skip(`${contractPath.pathname} is unavailable`);
      return;
    }

    callback();
  });
};

testWithContract('diagnostics privacy contract documents default allowed telemetry fields', () => {
  const defaultTelemetry = contractSection('Default Background Telemetry');
  for (const term of [
    'durations',
    'counts',
    'byte sizes',
    'process labels',
    'feature names',
    'coarse route or surface identifiers',
  ]) {
    assertSectionIncludes(defaultTelemetry, term);
  }
});

testWithContract('diagnostics privacy contract documents data that background telemetry must not collect', () => {
  const prohibitedByDefault = contractSection('Prohibited By Default');
  for (const term of [
    'raw file paths',
    'filenames',
    'prompts',
    'file content',
    'embeddings',
    'provider keys',
    'raw local database rows',
  ]) {
    assertSectionIncludes(prohibitedByDefault, term);
  }
});

testWithContract('diagnostics privacy contract distinguishes background telemetry from user exports', () => {
  assertContractIncludes('background telemetry');
  assertContractIncludes('user-initiated diagnostic export');
  assertContractIncludes('explicit consent');
  assertContractIncludes('leaving the device');
});

testWithContract('diagnostics privacy contract links related performance telemetry tickets', () => {
  for (const issueId of ['BST-376', 'BST-400', 'BST-401', 'BST-402', 'BST-403']) {
    assertContractIncludes(issueId, '');
  }
});
