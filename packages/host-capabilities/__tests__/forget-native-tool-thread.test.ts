import { getKnownFileMtime, recordKnownFileMtime } from '@brainstrike/agent';
import { expect, test } from 'vitest';
import {
  editFailureHintApplies,
  forgetSharedNativeToolThread,
  ReadWorkspaceFileCursorRegistry,
  recordEditFailure,
} from '../src/native-tools/index.js';

const cursor = {
  column: 1,
  endLine: 10,
  line: 1,
  mtimeMs: 1,
  path: '/notes.txt',
  requestedEndLine: null,
  requestedStartLine: null,
  rootId: 'root',
  size: 100,
};

test('a deleted thread loses its read cursors, read-before-write observations and loop guards; others keep theirs', () => {
  const registry = new ReadWorkspaceFileCursorRegistry();
  const deleted = { resourceId: 'workspace', threadId: 'deleted-thread' };
  const kept = { resourceId: 'workspace', threadId: 'kept-thread' };
  const deletedHandle = registry.issue(deleted, cursor);
  const keptHandle = registry.issue(kept, cursor);
  recordKnownFileMtime(deleted.threadId, '/root/notes.txt', 11);
  recordKnownFileMtime(kept.threadId, '/root/notes.txt', 22);
  recordEditFailure(deleted.threadId, 'root', '/notes.txt');
  recordEditFailure(kept.threadId, 'root', '/notes.txt');

  forgetSharedNativeToolThread(deleted.threadId, registry);

  expect(() => registry.resolve(deletedHandle, deleted)).toThrow(/unknown or no longer available/);
  expect(registry.resolve(keptHandle, kept)).toEqual(cursor);
  expect(getKnownFileMtime(deleted.threadId, '/root/notes.txt')).toBeUndefined();
  expect(getKnownFileMtime(kept.threadId, '/root/notes.txt')).toBe(22);
  // A fresh streak for the deleted thread starts at one; the kept thread's continues.
  expect(recordEditFailure(deleted.threadId, 'root', '/notes.txt')).toBe(1);
  expect(recordEditFailure(kept.threadId, 'root', '/notes.txt')).toBe(2);
  expect(editFailureHintApplies(1)).toBe(false);
});
