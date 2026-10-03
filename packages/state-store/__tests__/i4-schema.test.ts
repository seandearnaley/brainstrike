// M0-A2 item 4 (spike test/i4-schema.test.ts): schema evolution. The spike's events are the fixture schema: v1
// `text.text` became v2 `text.content`; an upgrader runs on every read; stored bytes are never rewritten. The indexer
// half (rebuild and gap rows in the derived store) is PR 5's.
import { afterEach, describe, expect, test } from 'vitest';
import { type EventSchema, type LooseEvent, UnknownEventError } from '../src/event-schema.js';
import type { RunEvent } from '../src/run-log-types.js';
import { StateStore } from '../src/state-store.js';
import { cleanupDirs, freshDir } from './helpers/fs.js';

afterEach(() => cleanupDirs());

type SpikeEvent =
  | { seq: number; v: 2; type: 'text'; content: string }
  | { seq: number; v: 2; type: 'tool-result'; output: string }
  | { seq: number; v: 2; type: 'tool-result'; preview: string; blob: string; bytes: number };

const SCHEMA: EventSchema<SpikeEvent> = {
  currentVersion: 2,
  upgraders: {
    1: (o: LooseEvent): LooseEvent => {
      if (o['type'] === 'text') {
        const { text, ...rest } = o;
        return { ...rest, content: text, v: 2 };
      }
      return { ...o, v: 2 };
    },
  },
  validate: (o, seq) => {
    switch (o['type']) {
      case 'text':
        return typeof o['content'] === 'string'
          ? { content: o['content'], seq, type: 'text', v: 2 }
          : { invalid: 'text without content' };
      case 'tool-result':
        if (typeof o['output'] === 'string') {
          return { output: o['output'], seq, type: 'tool-result', v: 2 };
        }
        if (
          typeof o['preview'] === 'string' &&
          typeof o['blob'] === 'string' &&
          typeof o['bytes'] === 'number'
        ) {
          return {
            blob: o['blob'],
            bytes: o['bytes'],
            preview: o['preview'],
            seq,
            type: 'tool-result',
            v: 2,
          };
        }
        return { invalid: 'tool-result without output or blob' };
      default:
        return { invalid: `unknown event type ${JSON.stringify(o['type'])}` };
    }
  },
};

const V1_TEXT = '{"v":1,"type":"text","text":"alpha from an old build"}';
const V2_TEXT = '{"v":2,"type":"text","content":"beta from this build"}';
const V1_TOOL = '{"v":1,"type":"tool-result","output":"gamma output"}';
const UNKNOWN_TYPE = '{"v":2,"type":"hologram","payload":1}';
const UNKNOWN_VERSION = '{"v":3,"type":"text","body":"from the future"}';
const appendRaw = (s: StateStore, bodies: string[]): Promise<unknown> =>
  s.append(bodies.map((b) => ({ event: JSON.parse(b) as RunEvent, threadId: 't1' })));

describe('item 4 · schema evolution', () => {
  test('mixed v1/v2: reads see v2 shapes; the stored bytes are not rewritten', async () => {
    const store = await StateStore.open(freshDir('i4mix'));
    try {
      await appendRaw(store, [V1_TEXT, V2_TEXT, V1_TOOL, V1_TEXT.replace('alpha', 'delta')]);
      expect(await store.readEvents('t1', SCHEMA, 'dev')).toEqual([
        { content: 'alpha from an old build', seq: 1, type: 'text', v: 2 },
        { content: 'beta from this build', seq: 2, type: 'text', v: 2 },
        { output: 'gamma output', seq: 3, type: 'tool-result', v: 2 },
        { content: 'delta from an old build', seq: 4, type: 'text', v: 2 },
      ]);
      expect((await store.read('t1'))[0]?.raw).toBe(`{"seq":1,${V1_TEXT.slice(1)}`);
    } finally {
      await store.close();
    }
  });

  test('dev mode: an unknown event type throws', async () => {
    const store = await StateStore.open(freshDir('i4dev'));
    try {
      await appendRaw(store, [V2_TEXT, UNKNOWN_TYPE]);
      await expect(store.readEvents('t1', SCHEMA, 'dev')).rejects.toThrow(UnknownEventError);
      await expect(store.readEvents('t1', SCHEMA, 'dev')).rejects.toThrow(
        /unknown event type "hologram"/
      );
    } finally {
      await store.close();
    }
  });

  test('prod mode: unknown type and unknown version are shown as visible errors in place, never dropped', async () => {
    const store = await StateStore.open(freshDir('i4prod'));
    try {
      await appendRaw(store, [V2_TEXT, UNKNOWN_TYPE, UNKNOWN_VERSION, V1_TEXT]);
      const evs = await store.readEvents('t1', SCHEMA, 'prod');
      expect(evs.map((e) => e.type)).toEqual(['text', 'unreadable', 'unreadable', 'text']);
      expect(evs[1]).toMatchObject({ reason: 'unknown event type "hologram"', seq: 2 });
      expect(evs[2]).toMatchObject({ reason: 'unknown event version 3', seq: 3 });
      expect(store.health().visibleErrors.map((e) => e.seq)).toEqual([2, 3]);
    } finally {
      await store.close();
    }
  });

  test('a purge tombstone decodes as purged in every mode', async () => {
    const store = await StateStore.open(freshDir('i4tomb'));
    try {
      await appendRaw(store, ['{"type":"purged"}']);
      expect(await store.readEvents('t1', SCHEMA, 'dev')).toEqual([{ seq: 1, type: 'purged' }]);
    } finally {
      await store.close();
    }
  });
});
