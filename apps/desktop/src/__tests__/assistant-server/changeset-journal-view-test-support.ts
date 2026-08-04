/**
 * Shared fixtures for the journal-sourced `ChangesetDiffService` unit suites
 * (BST-1113). The fold's regression net is large enough that its tests live in
 * two files — `changeset-journal-view.test.ts` (fold semantics) and
 * `changeset-journal-view-matrix.test.ts` (the review-traced S1-S8 sequence
 * matrix) — so the record builder and temp-dir helper are shared here rather
 * than duplicated. Splitting was forced by the repo-wide 1000-line file cap
 * (BST-1117); the suites are otherwise unchanged.
 */
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AssistantEditCheckpointRecord } from '@brainstrike/agent';

const createdRoots: string[] = [];

/** Remove every temp dir this module handed out. Call from `afterEach`. */
export async function cleanupTempDirs(): Promise<void> {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) {
      await fsPromises.rm(root, { force: true, recursive: true });
    }
  }
}

export async function makeTempDir(): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'brainstrike-changeset-journal-'));
  const real = await fsPromises.realpath(root);
  createdRoots.push(real);
  return real;
}

let recordCounter = 0;

export function record(
  overrides: Partial<AssistantEditCheckpointRecord> = {}
): AssistantEditCheckpointRecord {
  recordCounter += 1;
  return {
    afterExisted: true,
    afterHash: 'after-hash',
    beforeExisted: true,
    beforeHash: 'before-hash',
    beforeSize: 10,
    captureStatus: 'ok',
    fromPath: null,
    id: `record-${recordCounter}`,
    occurredAt: new Date(2026, 0, 1, 0, 0, recordCounter).toISOString(),
    op: 'write',
    path: 'a.txt',
    resourceId: 'resource-1',
    revertedAt: null,
    rootId: 'root-1',
    runId: 'run-1',
    threadId: 'thread-1',
    toolCallId: 'call-1',
    toolName: 'brainstrike.writeWorkspaceFile',
    ...overrides,
  };
}
