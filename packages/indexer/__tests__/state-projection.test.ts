import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { UnknownEventError } from '@brainstrike/state-store';
import { describe, expect, it } from 'vitest';
import { loadStateProjection } from '../src/state-projection.js';
import { validateIndexerOptions } from '../src/transport.js';

const module = new URL('./fixtures/state-schema.mjs', import.meta.url).href;

describe('producer-owned state schema projection', () => {
  it('projects historical events through the producer-owned upgrader', async () => {
    const projection = await loadStateProjection({ mode: 'dev', module });
    const raw = '{"seq":1,"v":1,"type":"text","text":"alpha from an old build"}';
    expect(projection.decode(raw)).toEqual({ gap: null, seq: 1, text: 'alpha from an old build' });
    expect(projection.decode('{"seq":2,"v":1,"type":"tool-result","output":"gamma"}')).toEqual({
      gap: null,
      seq: 2,
      text: 'gamma',
    });
  });

  it('throws on unknown committed events in dev mode', async () => {
    const projection = await loadStateProjection({ mode: 'dev', module });
    expect(() => projection.decode('{"seq":2,"v":2,"type":"hologram"}')).toThrow(UnknownEventError);
    expect(() => projection.decode('{"seq":3,"v":3,"type":"text","body":"future"}')).toThrow(
      'unknown event version 3'
    );
  });

  it('returns explicit in-place gaps for unknown types and versions in prod mode', async () => {
    const projection = await loadStateProjection({ mode: 'prod', module });
    expect(projection.decode('{"seq":2,"v":2,"type":"hologram"}')).toEqual({
      gap: 'unknown event type "hologram"',
      seq: 2,
      text: null,
    });
    expect(projection.decode('{"seq":3,"v":3,"type":"text","body":"future"}')).toEqual({
      gap: 'unknown event version 3',
      seq: 3,
      text: null,
    });
    expect(projection.decode('{"seq":4,"type":"purged"}')).toEqual({
      gap: null,
      seq: 4,
      text: null,
    });
  });

  it('binds projection identity to the producer module and explicit mode', async () => {
    const dev = await loadStateProjection({ mode: 'dev', module });
    const prod = await loadStateProjection({ mode: 'prod', module });
    expect(dev.identity).not.toBe(prod.identity);
    await expect(
      loadStateProjection({ mode: 'dev', module: 'https://example.com/schema.mjs' })
    ).rejects.toThrow('local file');
  });

  it('requires state truth and its explicit producer schema together before acquisition', () => {
    const options = {
      dbPath: path.join(os.tmpdir(), 'schema-options.sqlite'),
      embedding: { indexMode: 'text-only' },
      rootIds: [],
    };
    expect(() => validateIndexerOptions({ ...options, stateRoot: os.tmpdir() })).toThrow(
      'must be acquired together'
    );
    expect(() =>
      validateIndexerOptions({ ...options, stateProjection: { mode: 'dev', module } })
    ).toThrow('must be acquired together');
  });

  it('refuses a producer module without the required schema instead of indexing raw JSON', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'state-schema-module-')));
    try {
      const filename = path.join(root, 'invalid.mjs');
      await writeFile(filename, 'export const text = JSON.stringify;');
      await expect(
        loadStateProjection({ mode: 'prod', module: pathToFileURL(filename).href })
      ).rejects.toThrow();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
