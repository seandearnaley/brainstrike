import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildSelection,
  parseSelectArgs,
  renderSelectionJson,
} from '../ci-select.mjs';

test('parseSelectArgs defaults base and head', () => {
  assert.deepEqual(parseSelectArgs([]), {
    base: 'origin/main',
    format: 'json',
    head: 'HEAD',
  });
});

test('parseSelectArgs rejects duplicate flags', () => {
  assert.throws(
    () => parseSelectArgs(['--base', 'main', '--base', 'origin/main']),
    /--base can only be provided once/
  );
});

test('buildSelection returns files, lanes, expanded lanes, labels, and commands', () => {
  const selection = buildSelection({
    base: 'origin/main',
    baseSha: '1111111111111111111111111111111111111111',
    files: ['apps/desktop/src/embedding-host-manager.ts'],
    head: 'HEAD',
    headSha: '2222222222222222222222222222222222222222',
    mergeBase: '1111111111111111111111111111111111111111',
  });

  assert.deepEqual(selection.lanes, [
    'ci:desktop',
    'ci:embedding',
    'ci:coverage',
  ]);
  assert.deepEqual(selection.labels, [
    'ci:desktop',
    'ci:embedding',
    'ci:coverage',
  ]);
  assert.deepEqual(selection.expandedLanes, [
    'ci:desktop',
    'ci:embedding',
    'ci:coverage',
  ]);
  assert.equal(
    selection.commands.some((entry) => entry.name === 'desktop-regression'),
    true
  );
  assert.equal(
    selection.commands.some((entry) => entry.name === 'desktop-embedding'),
    true
  );
});

test('renderSelectionJson emits stable JSON', () => {
  const json = renderSelectionJson({
    base: 'origin/main',
    baseSha: '1',
    commands: [],
    expandedLanes: [],
    files: [],
    head: 'HEAD',
    headSha: '2',
    labels: [],
    lanes: [],
    mergeBase: '1',
  });

  assert.equal(json.endsWith('\n'), true);
  assert.deepEqual(Object.keys(JSON.parse(json)), [
    'base',
    'baseSha',
    'head',
    'headSha',
    'mergeBase',
    'files',
    'lanes',
    'expandedLanes',
    'labels',
    'commands',
  ]);
});
