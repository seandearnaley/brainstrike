import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';

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

  it('sources every channel from the role-scoped groups of the desktop IPC manifest', () => {
    // BST-1648: no channel literal lives in the hidden preload; every
    // `ipcRenderer` call reads the imported manifest. The GROUPS it may
    // reference are pinned so the hidden capability manifest stays scoped
    // (BST-1235/BST-1380): a `secrets`/`storage`/`git` group reference here
    // would widen the hidden hosts' reach and fails by name.
    const source = readHiddenPreloadSource();
    expect(source).toContain("from './platform/desktop-ipc-channels'");
    expect(source).toContain("from './ipc-domains/database.contract'");
    expect(source).toContain("from './ipc-domains/storage-preferences.contract'");
    expect(source).toContain('createIpcBridge(ipcRenderer, vectorPreferencesContract)');
    const manifestChannels = Object.values(DESKTOP_IPC_CHANNELS).flatMap((group) =>
      Object.values(group)
    );
    const duplicatedLiterals = manifestChannels.filter(
      (channel) => source.includes(`'${channel}'`) || source.includes(`"${channel}"`)
    );
    expect(duplicatedLiterals).toEqual([]);

    const referencedGroups = new Set(
      [...source.matchAll(/DESKTOP_IPC_CHANNELS\.([A-Za-z]+)\./g)].map((match) => match[1])
    );
    expect([...referencedGroups].sort()).toEqual([
      'chunkingHost',
      'embeddingHost',
      'files',
      'llmHost',
      'logging',
      'runtime',
    ]);
    for (const member of [
      'DESKTOP_IPC_CHANNELS.files.parserHostParse',
      'DESKTOP_IPC_CHANNELS.runtime.powerSnapshot',
      'DESKTOP_IPC_CHANNELS.runtime.powerState',
      'DESKTOP_IPC_CHANNELS.logging.getPreferences',
      'DESKTOP_IPC_CHANNELS.logging.ingestBufferedRecord',
      'DESKTOP_IPC_CHANNELS.logging.preferencesUpdated',
    ]) {
      expect(source).toContain(member);
    }
  });
});
