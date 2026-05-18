import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildSelection,
  collectGitSelection,
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

test('buildSelection rejects unsafe merge-base placeholders', () => {
  assert.throws(
    () =>
      buildSelection({
        base: 'origin/main',
        baseSha: '1111111111111111111111111111111111111111',
        files: ['packages/storage/src/opfs.ts'],
        head: 'HEAD',
        headSha: '2222222222222222222222222222222222222222',
        mergeBase: 'main;echo unsafe',
      }),
    /mergeBase must be a 40-character git SHA/
  );
});

test('collectGitSelection includes deleted files in risk selection', async () => {
  const commands = [];
  const runner = async (command, args) => {
    commands.push([command, args]);
    if (command === 'git' && args.join(' ') === 'merge-base origin/main HEAD') {
      return '1111111111111111111111111111111111111111\n';
    }
    if (command === 'git' && args.join(' ') === 'rev-parse origin/main') {
      return '1111111111111111111111111111111111111111\n';
    }
    if (command === 'git' && args.join(' ') === 'rev-parse HEAD') {
      return '2222222222222222222222222222222222222222\n';
    }
    if (
      command === 'git' &&
      args.join(' ') ===
        'diff --name-only --diff-filter=ACDMRTUXB 1111111111111111111111111111111111111111 HEAD'
    ) {
      return 'apps/web/src/deleted-route.tsx\n';
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };

  const selection = await collectGitSelection(
    { base: 'origin/main', head: 'HEAD' },
    runner
  );

  assert.deepEqual(selection.files, ['apps/web/src/deleted-route.tsx']);
  assert.deepEqual(selection.lanes, ['ci:web-e2e', 'ci:coverage']);
  assert.equal(
    commands.some(
      ([command, args]) =>
        command === 'git' &&
        args.join(' ') ===
          'diff --name-only --diff-filter=ACDMRTUXB 1111111111111111111111111111111111111111 HEAD'
    ),
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
