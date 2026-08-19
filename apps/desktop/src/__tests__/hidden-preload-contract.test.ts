import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESKTOP_PRELOAD_IPC_CHANNELS } from '../platform/desktop-ipc-channels';

function readHiddenPreloadSource(): string {
  return readFileSync(path.resolve(process.cwd(), 'src', 'hidden-preload.ts'), 'utf8');
}

describe('hidden renderer preload contract', () => {
  it('contains explicit capability manifests for every hidden renderer role', () => {
    const source = readHiddenPreloadSource();

    expect(source).toContain("'chunking-host'");
    expect(source).toContain("'embedding-host'");
    expect(source).toContain("'llm-host'");
    expect(source).toContain('brainstrike-hidden-renderer-role');
  });

  it('cannot expose provider secrets or assistant server credentials', () => {
    const source = readHiddenPreloadSource();

    expect(source).not.toMatch(/exposeInMainWorld\(['"]secrets['"]/);
    expect(source).not.toMatch(/exposeInMainWorld\(['"]assistant['"]/);
    expect(source).not.toContain('secrets:get');
    expect(source).not.toContain('assistant:get-auth');
    expect(source).not.toContain('assistant:get-url');
  });

  it('cannot expose the env bootstrap bridge (BST-1363: visible-ui settings surface only)', () => {
    const source = readHiddenPreloadSource();

    expect(source).not.toMatch(/exposeInMainWorld\(['"]envBootstrap['"]/);
    expect(source).not.toContain('secrets:envBootstrap');
  });

  it('cannot expose the provider OAuth bridge (BST-1355: interactive visible-ui only)', () => {
    const source = readHiddenPreloadSource();

    expect(source).not.toMatch(/exposeInMainWorld\(['"]providerAuth['"]/);
    expect(source).not.toContain('provider-auth:');
  });

  it('cannot expose the unrestricted key-value storage bridge (BST-1380: scoped vector preferences only)', () => {
    const source = readHiddenPreloadSource();

    expect(source).not.toContain('storage:getItem');
    expect(source).not.toContain('storage:setItem');
    expect(source).not.toContain('storage:getAllKeys');
    expect(source).not.toContain('storage:clear');
  });

  it('pins every self-contained channel literal to the canonical channel catalog', () => {
    const source = readHiddenPreloadSource();
    const expectedChannels = [
      DESKTOP_PRELOAD_IPC_CHANNELS.db.applyManagedCacheBatch,
      DESKTOP_PRELOAD_IPC_CHANNELS.db.diagnostics,
      DESKTOP_PRELOAD_IPC_CHANNELS.db.exec,
      DESKTOP_PRELOAD_IPC_CHANNELS.db.insertChunksAndEnqueueEmbeddingJobs,
      DESKTOP_PRELOAD_IPC_CHANNELS.db.invalidateManagedCacheEntriesByIdentity,
      DESKTOP_PRELOAD_IPC_CHANNELS.db.query,
      DESKTOP_PRELOAD_IPC_CHANNELS.db.schedulerSnapshot,
      DESKTOP_PRELOAD_IPC_CHANNELS.db.test,
      DESKTOP_PRELOAD_IPC_CHANNELS.db.transaction,
      DESKTOP_PRELOAD_IPC_CHANNELS.files.parserHostParse,
      DESKTOP_PRELOAD_IPC_CHANNELS.runtime.powerSnapshot,
      DESKTOP_PRELOAD_IPC_CHANNELS.runtime.powerState,
      DESKTOP_PRELOAD_IPC_CHANNELS.vectorPreferences.clear,
      DESKTOP_PRELOAD_IPC_CHANNELS.vectorPreferences.read,
      DESKTOP_PRELOAD_IPC_CHANNELS.vectorPreferences.write,
    ];

    for (const channel of expectedChannels) {
      expect(source).toContain(`'${channel}'`);
    }
  });
});
