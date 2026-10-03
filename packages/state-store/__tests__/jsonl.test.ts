import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { BLOBS_DIR, StateStore } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';
import { appendInputs } from './helpers/testkit.js';

afterEach(() => cleanupDirs());

test('JSONL round trip preserves sequences, timestamps, raw counts and content-addressed blobs across threads', async () => {
  const root = freshDir('jsonl-source');
  const store = await StateStore.open(root);
  const target = freshDir('jsonl-target');
  const imported = await StateStore.open(target);
  try {
    await appendInputs(store, 'a', [{ output: 'x'.repeat(14_000), type: 'tool-result' }]);
    await store.append([
      { event: { text: 'hello', type: 'ui.chunk' }, rawCount: 3, threadId: 'b' },
    ]);
    const path = join(freshDir('jsonl'), 'run-log.jsonl');
    await store.exportJsonl(path);
    await imported.importJsonl(path);
    expect(await imported.read('a')).toEqual(await store.read('a'));
    expect(await imported.read('b')).toEqual(await store.read('b'));
    const blob = (await imported.read('a'))[0]?.event['blob'] as string;
    expect(readFileSync(join(target, BLOBS_DIR, blob), 'utf8')).toBe('x'.repeat(14_000));
    await expect(imported.importJsonl(path)).rejects.toThrow(/empty/);
  } finally {
    await store.close();
    await imported.close();
  }
});

test('malformed or checksum-damaged JSONL imports write no rows', async () => {
  const store = await StateStore.open(freshDir('jsonl-bad'));
  try {
    const path = join(freshDir('jsonl'), 'bad.jsonl');
    writeFileSync(
      path,
      '{"format":"brainstrike-run-log","version":1}\n{"kind":"event","threadId":"a","seq":1,"payload":"{\\"seq\\":1,\\"type\\":\\"text\\"}","crc":0,"rawCount":null,"createdAt":1}\n'
    );
    await expect(store.importJsonl(path)).rejects.toThrow(/checksum/);
    expect(await store.threads()).toEqual([]);
    writeFileSync(path, '{"format":"brainstrike-run-log","version":1}\nnot json\n');
    await expect(store.importJsonl(path)).rejects.toThrow();
    expect(await store.threads()).toEqual([]);
  } finally {
    await store.close();
  }
});
