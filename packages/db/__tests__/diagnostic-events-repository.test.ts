import type { DiagnosticEvent } from '@brainstrike/utils/diagnostics';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DIAGNOSTIC_RETENTION_MAX_ROWS,
  DiagnosticEventsRepository,
} from '../src/repositories/diagnostic-events-repository.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

const NUL = String.fromCharCode(0);
// U+2400 SYMBOL FOR NULL: the visible stand-in stored in place of a NUL.
const NUL_MARKER = String.fromCharCode(0x24_00);
const REPLACEMENT_CHARACTER = String.fromCharCode(0xff_fd);
// The high half of a surrogate pair that a bounded `slice` leaves behind when
// it splits an emoji (boundWithMarker truncates by UTF-16 code unit).
const LONE_HIGH_SURROGATE = '🙂'.slice(0, 1);

function makeEvent(overrides: Partial<DiagnosticEvent>): DiagnosticEvent {
  return {
    appVersion: 'v',
    causeChain: null,
    code: null,
    context: null,
    fingerprint: 'fp-default',
    id: `id-${Math.random().toString(36).slice(2)}`,
    message: 'message',
    occurredAt: Date.now(),
    platform: 'test',
    resourceId: null,
    rootId: null,
    runId: null,
    scope: 'Scope',
    sessionId: 'session',
    severity: 'error',
    source: 'web-renderer',
    stack: null,
    threadId: null,
    ...overrides,
  };
}

describe('DiagnosticEventsRepository', () => {
  let db: PGlite;
  let repo: DiagnosticEventsRepository;

  beforeEach(async () => {
    db = await createMigratedTestDb();
    repo = new DiagnosticEventsRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('inserts a batch and queries by filters newest-first', async () => {
    await repo.insertBatch([
      makeEvent({ id: 'a', occurredAt: 1000, severity: 'warn', threadId: 't1' }),
      makeEvent({ id: 'b', occurredAt: 2000, severity: 'error', threadId: 't1' }),
      makeEvent({ id: 'c', occurredAt: 3000, severity: 'error', threadId: 't2' }),
    ]);
    const rows = await repo.queryEvents({ severity: 'error', threadId: 't1' });
    expect(rows.map((row) => row.id)).toEqual(['b']);
    const all = await repo.queryEvents({});
    expect(all.map((row) => row.id)).toEqual(['c', 'b', 'a']);
  });

  it('counts occurrences by fingerprint with first/last seen', async () => {
    await repo.insertBatch([
      makeEvent({ fingerprint: 'fp-x', id: 'a', occurredAt: 1000 }),
      makeEvent({ fingerprint: 'fp-x', id: 'b', occurredAt: 5000 }),
      makeEvent({ fingerprint: 'fp-y', id: 'c', occurredAt: 2000 }),
    ]);
    const stats = await repo.countByFingerprint('fp-x', 0);
    expect(stats).toEqual({ count: 2, firstSeenMs: 1000, lastSeenMs: 5000 });
  });

  it('groups recurring diagnostics by fingerprint with bounded filters and latest context', async () => {
    await repo.insertBatch([
      makeEvent({
        code: 'provider_failed',
        fingerprint: 'fp-x',
        id: 'a',
        message: 'first failure',
        occurredAt: 1000,
        runId: 'run-1',
        severity: 'error',
        source: 'electron-main',
        threadId: 'thread-1',
      }),
      makeEvent({
        code: 'provider_failed',
        fingerprint: 'fp-x',
        id: 'b',
        message: 'latest failure',
        occurredAt: 5000,
        runId: 'run-1',
        severity: 'error',
        source: 'electron-main',
        threadId: 'thread-1',
      }),
      makeEvent({
        fingerprint: 'fp-y',
        id: 'c',
        occurredAt: 2000,
        runId: 'run-2',
        severity: 'warn',
        threadId: 'thread-2',
      }),
    ]);

    const groups = await repo.queryFingerprintGroups({
      runId: 'run-1',
      severity: 'error',
      sinceMs: 500,
      untilMs: 6000,
    });

    expect(groups).toEqual([
      {
        code: 'provider_failed',
        count: 2,
        fingerprint: 'fp-x',
        firstSeenMs: 1000,
        lastSeenMs: 5000,
        latestMessage: 'latest failure',
        severity: 'error',
        source: 'electron-main',
      },
    ]);
  });

  it('orders fingerprint groups by recurrence and selects each latest row once', async () => {
    await repo.insertBatch([
      makeEvent({
        code: 'old-code',
        fingerprint: 'fp-recurring',
        id: 'recurring-old',
        message: 'old recurring failure',
        occurredAt: 1000,
        severity: 'warn',
        source: 'web-renderer',
      }),
      makeEvent({
        code: 'latest-code',
        fingerprint: 'fp-recurring',
        id: 'recurring-new',
        message: 'latest recurring failure',
        occurredAt: 2000,
        severity: 'error',
        source: 'electron-main',
      }),
      makeEvent({
        fingerprint: 'fp-recent-single',
        id: 'recent-single',
        message: 'newer but not recurring',
        occurredAt: 5000,
      }),
    ]);

    const groups = await repo.queryFingerprintGroups({ limit: 2 });

    expect(groups.map((group) => group.fingerprint)).toEqual(['fp-recurring', 'fp-recent-single']);
    expect(groups[0]).toMatchObject({
      code: 'latest-code',
      count: 2,
      latestMessage: 'latest recurring failure',
      severity: 'error',
      source: 'electron-main',
    });
  });

  it('purges beyond the age bound oldest-first and reports the count', async () => {
    const now = Date.now();
    await repo.insertBatch([
      makeEvent({ id: 'old', occurredAt: now - 40 * 24 * 60 * 60 * 1000 }),
      makeEvent({ id: 'fresh', occurredAt: now }),
    ]);
    const deleted = await repo.purge();
    expect(deleted).toBe(1);
    const rows = await repo.queryEvents({});
    expect(rows.map((row) => row.id)).toEqual(['fresh']);
  });

  it('purges beyond the row bound oldest-first', async () => {
    const events = Array.from({ length: 10 }, (_, index) =>
      makeEvent({ id: `e${index}`, occurredAt: 1000 + index })
    );
    await repo.insertBatch(events);
    const deleted = await repo.purge({ maxAgeMs: Number.MAX_SAFE_INTEGER, maxRows: 4 });
    expect(deleted).toBe(6);
    const rows = await repo.queryEvents({});
    expect(rows).toHaveLength(4);
    expect(rows[0]?.id).toBe('e9');
    expect(DIAGNOSTIC_RETENTION_MAX_ROWS).toBe(20_000);
  });

  describe('characters PostgreSQL text and jsonb cannot store', () => {
    it('keeps every sibling event when one row carries a NUL character', async () => {
      // Production shape (2026-09-15): forge-service logged its NUL-joined
      // in-memory PR cache key as `context.key`, and PostgreSQL rejected the
      // whole multi-row INSERT with 22P05.
      await repo.insertBatch([
        makeEvent({ id: 'before', occurredAt: 1000 }),
        makeEvent({
          context: { detail: 'DB host request timed out: query', key: `/repo${NUL}fix/branch` },
          id: 'poisoned',
          occurredAt: 2000,
        }),
        makeEvent({ id: 'after', occurredAt: 3000 }),
      ]);

      const rows = await repo.queryEvents({});
      expect(rows.map((row) => row.id)).toEqual(['after', 'poisoned', 'before']);
      expect(rows[1]?.context).toEqual({
        detail: 'DB host request timed out: query',
        key: `/repo${NUL_MARKER}fix/branch`,
        storageReplacements: { context: 1 },
      });
    });

    it('records a text-column replacement on an event that had no context', async () => {
      await repo.insertBatch([
        makeEvent({ context: null, id: 'no-context', stack: `at read${NUL}` }),
      ]);

      const [row] = await repo.queryEvents({});
      expect(row?.stack).toBe(`at read${NUL_MARKER}`);
      expect(row?.context).toEqual({ storageReplacements: { stack: 1 } });
    });

    it('rewrites a toJSON value as it would be stored, not as its own properties', async () => {
      await repo.insertBatch([
        makeEvent({ context: { at: new Date(0), note: `read${NUL}` }, id: 'dated' }),
      ]);

      const [row] = await repo.queryEvents({});
      expect(row?.context).toEqual({
        at: '1970-01-01T00:00:00.000Z',
        note: `read${NUL_MARKER}`,
        storageReplacements: { context: 1 },
      });
    });

    it('replaces NUL with a visible marker in every column and records the rewrite per field', async () => {
      const withNul = (label: string) => `${label}${NUL}`;
      const marked = (label: string) => `${label}${NUL_MARKER}`;
      await repo.insertBatch([
        makeEvent({
          appVersion: withNul('app'),
          causeChain: [
            { code: withNul('code'), message: withNul('cause'), name: withNul('Error') },
          ],
          code: withNul('code'),
          context: { [withNul('key')]: withNul('value'), nested: [withNul('item')] },
          fingerprint: withNul('fp'),
          id: withNul('id'),
          message: withNul('message'),
          occurredAt: 1000,
          platform: withNul('platform'),
          resourceId: withNul('resource'),
          rootId: withNul('root'),
          runId: withNul('run'),
          scope: withNul('scope'),
          sessionId: withNul('session'),
          source: withNul('source'),
          stack: withNul('stack'),
          threadId: withNul('thread'),
        }),
      ]);

      const [row] = await repo.queryEvents({});
      expect(row).toEqual({
        appVersion: marked('app'),
        causeChain: [{ code: marked('code'), message: marked('cause'), name: marked('Error') }],
        code: marked('code'),
        context: {
          [marked('key')]: marked('value'),
          nested: [marked('item')],
          storageReplacements: {
            appVersion: 1,
            causeChain: 3,
            code: 1,
            context: 3,
            fingerprint: 1,
            id: 1,
            message: 1,
            platform: 1,
            resourceId: 1,
            rootId: 1,
            runId: 1,
            scope: 1,
            sessionId: 1,
            source: 1,
            stack: 1,
            threadId: 1,
          },
        },
        fingerprint: marked('fp'),
        id: marked('id'),
        message: marked('message'),
        occurredAt: 1000,
        platform: marked('platform'),
        resourceId: marked('resource'),
        rootId: marked('root'),
        runId: marked('run'),
        scope: marked('scope'),
        sessionId: marked('session'),
        severity: 'error',
        source: marked('source'),
        stack: marked('stack'),
        threadId: marked('thread'),
      });
    });

    it('replaces a lone surrogate with U+FFFD and records it instead of rejecting the batch', async () => {
      const loneLowSurrogate = '🙂'.slice(1);
      await repo.insertBatch([
        makeEvent({ id: 'before', occurredAt: 1000 }),
        makeEvent({
          context: { truncatedContext: `split ${LONE_HIGH_SURROGATE}` },
          id: 'split-emoji',
          message: `${loneLowSurrogate} split ${LONE_HIGH_SURROGATE}`,
          occurredAt: 2000,
        }),
        makeEvent({ id: 'after', occurredAt: 3000 }),
      ]);

      const rows = await repo.queryEvents({});
      expect(rows.map((row) => row.id)).toEqual(['after', 'split-emoji', 'before']);
      expect(rows[1]?.message).toBe(`${REPLACEMENT_CHARACTER} split ${REPLACEMENT_CHARACTER}`);
      expect(rows[1]?.context).toEqual({
        storageReplacements: { context: 1, message: 2 },
        truncatedContext: `split ${REPLACEMENT_CHARACTER}`,
      });
    });

    it('stores storable events exactly as given, without a replacement record', async () => {
      const context = {
        count: 3,
        emoji: '🙂',
        escapedText: '\\u0000 is six characters, not a NUL',
        none: null,
        ok: true,
      };
      await repo.insertBatch([
        makeEvent({ context, id: 'clean', message: 'literal \\u0000 text 🙂' }),
      ]);

      const [row] = await repo.queryEvents({});
      expect(row?.context).toEqual(context);
      expect(row?.message).toBe('literal \\u0000 text 🙂');
    });

    it('stores an omitted nullable field as NULL instead of throwing', async () => {
      // Runtime shape: an event that lost a null-valued key crossing a
      // serialization boundary. PGlite binds `undefined` as NULL, so this
      // inserted before the rewrite existed and must still insert.
      const { stack: _omitted, ...withoutStack } = makeEvent({ id: 'no-stack', occurredAt: 1000 });
      await repo.insertBatch([
        withoutStack as unknown as DiagnosticEvent,
        makeEvent({ id: 'sibling', occurredAt: 2000 }),
      ]);

      const rows = await repo.queryEvents({});
      expect(rows.map((row) => row.id)).toEqual(['sibling', 'no-stack']);
      expect(rows[1]?.stack).toBeNull();
    });

    it('stores a context whose toJSON renders nothing as NULL instead of throwing', async () => {
      await repo.insertBatch([
        makeEvent({
          context: { toJSON: () => undefined },
          id: 'renders-nothing',
          occurredAt: 1000,
        }),
        makeEvent({ id: 'sibling', occurredAt: 2000 }),
      ]);

      const rows = await repo.queryEvents({});
      expect(rows.map((row) => row.id)).toEqual(['sibling', 'renders-nothing']);
      expect(rows[1]?.context).toBeNull();
    });
  });
});
