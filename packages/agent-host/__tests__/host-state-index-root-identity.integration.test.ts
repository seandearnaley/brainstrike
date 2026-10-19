import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { canonicalRoot, StateStore } from '@brainstrike/state-store';
import { expect, test } from 'vitest';
import { openHostStateIndex } from '../src/host-state-index.js';

/** Whether the temp directory's file system ignores case: macOS and Windows by default, not Linux. */
const tmpFoldsCase = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), 'bs-host-index-case-'));
  try {
    return existsSync(join(dirname(probe), basename(probe).toUpperCase()));
  } finally {
    rmSync(probe, { recursive: true });
  }
})();

// BST-2234: the index's root id is durable (its root rows and memory vector scopes). Derived with JS realpathSync, a
// root reached through another case (or a Windows 8.3 short name) got another identity than the root lock records.
test.skipIf(!tmpFoldsCase)(
  "a host state index opened through another spelling of its root takes the root's canonical identity",
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'bs-host-index-identity-'));
    const store = await StateStore.open(root);
    try {
      const index = await openHostStateIndex(join(dirname(root), basename(root).toUpperCase()));
      try {
        expect(index.rootId).toBe(canonicalRoot(root));
        expect(index.rootId).toBe(store.lock.owner.root);
      } finally {
        await index.close();
      }
    } finally {
      await store.close();
      await rm(root, { force: true, recursive: true });
    }
  }
);
