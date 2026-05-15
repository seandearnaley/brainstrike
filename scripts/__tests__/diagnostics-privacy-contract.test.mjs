import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const contractPath = 'docs/diagnostics-privacy-contract.md';
let contractSource = '';
let contractReadError = null;

try {
  contractSource = await readFile(contractPath, 'utf8');
} catch (error) {
  contractReadError = error;
}

test('diagnostics privacy contract exists in the repo docs', () => {
  assert.equal(contractReadError, null, `${contractPath} should exist`);
});

test('diagnostics privacy contract documents default allowed telemetry fields', () => {
  for (const term of [
    'durations',
    'counts',
    'byte sizes',
    'process labels',
    'feature names',
    'coarse route or surface identifiers',
  ]) {
    assert.match(contractSource, new RegExp(term, 'i'));
  }
});

test('diagnostics privacy contract documents data that background telemetry must not collect', () => {
  for (const term of [
    'raw file paths',
    'filenames',
    'prompts',
    'file content',
    'embeddings',
    'provider keys',
    'raw local database rows',
  ]) {
    assert.match(contractSource, new RegExp(term, 'i'));
  }
});

test('diagnostics privacy contract distinguishes background telemetry from user exports', () => {
  assert.match(contractSource, /background telemetry/i);
  assert.match(contractSource, /user-initiated diagnostic export/i);
  assert.match(contractSource, /explicit consent/i);
  assert.match(contractSource, /leaving the device/i);
});

test('diagnostics privacy contract links related performance telemetry tickets', () => {
  for (const issueId of ['BST-376', 'BST-400', 'BST-401', 'BST-402', 'BST-403']) {
    assert.match(contractSource, new RegExp(issueId));
  }
});
