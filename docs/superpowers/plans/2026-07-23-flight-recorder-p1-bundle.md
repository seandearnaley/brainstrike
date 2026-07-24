# Flight Recorder P1 + Debug Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Durable `brainstrike_diagnostic_events` store capturing warn+ records from all processes, plus a Copy-debug-bundle button on failed assistant messages that assembles a bounded, redacted, LLM-ready Markdown document.

**Architecture:** One capture seam (the existing Pino `addLogListener` fan-out) feeds a batched `DiagnosticEventWriter` that inserts into a new FK-less PGlite table (dual-runner migration, bounded retention, factory-reset wired). Desktop main + hidden-host records reach the visible renderer's writer over a new push channel on the existing logging IPC contract. The bundle builder joins the new table with the existing run/event/usage/outcome/message tables by `run_id`/`thread_id` and formats one versioned Markdown document; a `DebugBundleProvider` context (RunVerdictProvider pattern) binds it to a copy button rendered beside `AssistantMessageError`.

**Tech Stack:** TypeScript strict, PGlite (PG18), Pino v10 logger seam, React 19, Vitest (+ real-PGlite integration tests), pnpm workspaces.

**Spec:** `docs/error-observability-design-2026-07-23.md` (§4 store/writer, §5 bundle, §12 invariants). Decisions locked: retention 30 days / 20,000 rows; severity floor `warn`; bundle includes redacted transcript; table name `brainstrike_diagnostic_events`; **Copy only** in this PR (Save-to-file is a follow-up); desktop NDJSON file sink, Log Viewer source, `run_errors` enrichment, and `queryDiagnostics` tool are later phases.

## Global Constraints

- TypeScript strict; never `any` — `unknown` + narrowing; discriminated unions over enums (existing `LogLevel` enum stays as-is).
- NO SILENT FALLBACKS: malformed input throws or surfaces visibly; truncation always leaves a visible marker; dropped events are counted and reported.
- Schema changes register in BOTH runners: `packages/db/src/migrations/index.ts` AND `packages/db/src/drizzle/migrate.ts` (`customMigration`).
- New persistence MUST be wired into factory reset (desktop `db-ipc.ts` clearAll AND web `db-provider.tsx` reset) per `docs/agents/platform-contracts.md`.
- Capability gating by composition — never `isElectron()` in shared code.
- Never awaited on the assistant stream path; writes are batched/async.
- Never log or persist command text, cwd, env, or PTY output (command-session privacy contract) — the capture layer must not add them.
- Kebab-case filenames; hooks `use-*.ts`.
- The bar per task: clean build, lint (`pnpm dlx ultracite fix` before committing), type check, unit tests green in the same run.
- All file paths below are relative to the repo worktree root.

## File Structure (locked decomposition)

```
packages/utils/src/diagnostics/diagnostic-events.ts        # event type, bounds, fingerprint, LogRecord→event
packages/utils/src/diagnostics/diagnostic-event-writer.ts  # pure batching writer (sink-injected)
packages/db/src/migrations/072-diagnostic-events.ts        # table + indexes
packages/db/src/repositories/diagnostic-events-repository.ts # insertBatch / query / purge
packages/app-shell/src/diagnostics/diagnostic-sink-bridge.tsx # renderer wiring (listener→writer→repo)
packages/app-shell/src/diagnostics/debug-bundle.ts         # collect + format the bundle
packages/app-shell/src/hooks/use-debug-bundle.ts           # binding for the UI provider
packages/ui/src/assistant-ui-panel/debug-bundle-context.tsx # provider seam (RunVerdict pattern)
packages/ui/src/assistant-ui-panel/copy-debug-bundle-button.tsx # the button
apps/desktop/src/platform/logging-api-contract.ts          # + durableRecord push channel (modify)
apps/desktop/src/logging-ipc.ts                            # + main-side warn+ push (modify)
apps/desktop/src/preload.ts                                # + onDurableRecord bridge (modify)
apps/desktop/src/ipc-domains/db-ipc.ts                     # + factory-reset purge (modify)
packages/db/src/db-provider.tsx                            # + web reset purge (modify)
packages/ui/src/error-boundary.tsx                         # + default logging (modify)
docs/agents/platform-contracts.md                          # + DIAGNOSTIC EVENTS section (modify)
```

---

### Task 1: Diagnostic event contract module

**Files:**
- Create: `packages/utils/src/diagnostics/diagnostic-events.ts`
- Modify: `packages/utils/package.json` (add `./diagnostics` subpath export mirroring the existing `./logger` entry — copy its exact `types`/`import`/`require` shape with the new path)
- Test: `packages/utils/src/__tests__/diagnostic-events.test.ts`

**Interfaces:**
- Consumes: `LogRecord`, `LogLevel` from `../logger` ; `redactSensitiveLogValue` (already exported from logger module — verify export name with `grep -n "redactSensitiveLogValue" packages/utils/src/logger.ts`; if unexported, export it).
- Produces (later tasks depend on these exact names):
  - `type DiagnosticSeverity = 'warn' | 'error' | 'fatal'`
  - `interface DiagnosticEvent { id: string; occurredAt: number; severity: DiagnosticSeverity; source: string; scope: string | null; code: string | null; message: string; stack: string | null; causeChain: readonly { name: string; message: string; code?: string }[] | null; context: Record<string, unknown> | null; fingerprint: string; sessionId: string; runId: string | null; threadId: string | null; resourceId: string | null; rootId: string | null; appVersion: string; platform: string }`
  - `DIAGNOSTIC_MESSAGE_MAX_CHARS = 2000`, `DIAGNOSTIC_STACK_MAX_CHARS = 8000`, `DIAGNOSTIC_CONTEXT_MAX_CHARS = 8000`
  - `computeDiagnosticFingerprint(code: string | null, scope: string | null, message: string): string`
  - `logRecordToDiagnosticEvent(record: LogRecord, env: { sessionId: string; source: string; appVersion: string; platform: string; makeId: () => string }): DiagnosticEvent | null`

- [ ] **Step 1: Write the failing test**

```ts
// packages/utils/src/__tests__/diagnostic-events.test.ts
import { describe, expect, it } from 'vitest';
import {
  computeDiagnosticFingerprint,
  DIAGNOSTIC_MESSAGE_MAX_CHARS,
  logRecordToDiagnosticEvent,
} from '../diagnostics/diagnostic-events';
import { LogLevel } from '../logger';

const ENV = {
  appVersion: '1.0.0-test',
  makeId: () => 'id-1',
  platform: 'test',
  sessionId: 'session-1',
  source: 'web-renderer',
};

describe('computeDiagnosticFingerprint', () => {
  it('is stable across uuids, digits, and paths in the message', () => {
    const a = computeDiagnosticFingerprint(null, 'Scope', 'run 123e4567-e89b-42d3-a456-426614174000 failed after 250ms at /Users/x/y.ts');
    const b = computeDiagnosticFingerprint(null, 'Scope', 'run 99999999-aaaa-4bbb-8ccc-000000000001 failed after 9001ms at /home/z/q.ts');
    expect(a).toBe(b);
  });

  it('differs when the code differs', () => {
    expect(computeDiagnosticFingerprint('a', 's', 'm')).not.toBe(computeDiagnosticFingerprint('b', 's', 'm'));
  });
});

describe('logRecordToDiagnosticEvent', () => {
  it('returns null below the warn floor', () => {
    expect(
      logRecordToDiagnosticEvent(
        { args: ['hello'], bindings: {}, level: LogLevel.INFO, message: 'hello', timestamp: 1 },
        ENV
      )
    ).toBeNull();
  });

  it('maps a warn record with scope, code metadata, and correlation ids', () => {
    const event = logRecordToDiagnosticEvent(
      {
        args: ['boom', { code: 'stream_inactivity_timeout', runId: 'run-1', threadId: 'thread-1' }],
        bindings: { appName: 'brainstrike' },
        level: LogLevel.ERROR,
        message: 'boom',
        scope: 'AgentStream',
        timestamp: 1234,
      },
      ENV
    );
    expect(event).toMatchObject({
      code: 'stream_inactivity_timeout',
      fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
      id: 'id-1',
      message: 'boom',
      occurredAt: 1234,
      runId: 'run-1',
      scope: 'AgentStream',
      sessionId: 'session-1',
      severity: 'error',
      source: 'web-renderer',
      threadId: 'thread-1',
    });
  });

  it('walks Error args into stack + cause chain and truncates visibly', () => {
    const cause = new Error('root cause');
    const err = new Error('x'.repeat(DIAGNOSTIC_MESSAGE_MAX_CHARS + 50), { cause });
    const event = logRecordToDiagnosticEvent(
      { args: ['failed', err], bindings: {}, level: LogLevel.ERROR, message: 'failed', timestamp: 1 },
      ENV
    );
    expect(event?.stack).toContain('Error');
    expect(event?.causeChain?.[0]?.message).toBe('root cause');
    expect(event?.context?.errorMessage).toContain('…[truncated');
  });

  it('redacts sensitive keys in context', () => {
    const event = logRecordToDiagnosticEvent(
      { args: ['m', { apiKey: 'sk-secret', ok: 1 }], bindings: {}, level: LogLevel.WARN, message: 'm', timestamp: 1 },
      ENV
    );
    expect(JSON.stringify(event?.context)).not.toContain('sk-secret');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @brainstrike/utils vitest run src/__tests__/diagnostic-events.test.ts`
Expected: FAIL — cannot resolve `../diagnostics/diagnostic-events`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/utils/src/diagnostics/diagnostic-events.ts
import { LogLevel, type LogRecord } from '../logger';
// If redactSensitiveLogValue is not exported from ../logger, export it there
// (it exists as an internal function) — do NOT reimplement redaction.
import { redactSensitiveLogValue } from '../logger';

export type DiagnosticSeverity = 'warn' | 'error' | 'fatal';

export interface DiagnosticCauseEntry {
  readonly code?: string;
  readonly message: string;
  readonly name: string;
}

export interface DiagnosticEvent {
  readonly appVersion: string;
  readonly causeChain: readonly DiagnosticCauseEntry[] | null;
  readonly code: string | null;
  readonly context: Record<string, unknown> | null;
  readonly fingerprint: string;
  readonly id: string;
  readonly message: string;
  readonly occurredAt: number;
  readonly platform: string;
  readonly resourceId: string | null;
  readonly rootId: string | null;
  readonly runId: string | null;
  readonly scope: string | null;
  readonly sessionId: string;
  readonly severity: DiagnosticSeverity;
  readonly source: string;
  readonly stack: string | null;
  readonly threadId: string | null;
}

export const DIAGNOSTIC_MESSAGE_MAX_CHARS = 2000;
export const DIAGNOSTIC_STACK_MAX_CHARS = 8000;
export const DIAGNOSTIC_CONTEXT_MAX_CHARS = 8000;
const MAX_CAUSE_DEPTH = 5;

const SEVERITY_BY_LEVEL: Partial<Record<LogLevel, DiagnosticSeverity>> = {
  [LogLevel.WARN]: 'warn',
  [LogLevel.ERROR]: 'error',
  [LogLevel.FATAL]: 'fatal',
};

/** Visible-truncation helper: elision must never be silent (design §4.2). */
export function boundWithMarker(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const suffix = `…[truncated ${value.length - maxChars} chars]`;
  return value.slice(0, maxChars) + suffix;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX_RE = /\b[0-9a-f]{8,}\b/gi;
const PATH_RE = /(?:[A-Za-z]:)?(?:[\\/][\w.@-]+){2,}/g;
const DIGIT_RE = /\d+/g;

/** FNV-1a 64-bit over the normalized identity (sync, dependency-free — md5 in
 * the design doc was illustrative; the property that matters is stability). */
export function computeDiagnosticFingerprint(
  code: string | null,
  scope: string | null,
  message: string
): string {
  const normalized = message
    .replace(UUID_RE, '<uuid>')
    .replace(PATH_RE, '<path>')
    .replace(HEX_RE, '<hex>')
    .replace(DIGIT_RE, '<n>');
  const identity = `${code ?? ''}|${scope ?? ''}|${normalized}`;
  let hash = 0xcb_f2_9c_e4_84_22_23_25n;
  const prime = 0x1_00_00_00_01_b3n;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= BigInt(identity.charCodeAt(index));
    hash = (hash * prime) & 0xff_ff_ff_ff_ff_ff_ff_ffn;
  }
  return hash.toString(16).padStart(16, '0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function walkCauseChain(error: Error): DiagnosticCauseEntry[] {
  const chain: DiagnosticCauseEntry[] = [];
  let current: unknown = error.cause;
  while (current instanceof Error && chain.length < MAX_CAUSE_DEPTH) {
    const code = isRecord(current) && typeof current['code'] === 'string' ? current['code'] : undefined;
    chain.push({ code, message: boundWithMarker(current.message, 500), name: current.name });
    current = current.cause;
  }
  return chain;
}

export interface DiagnosticEventEnv {
  readonly appVersion: string;
  readonly makeId: () => string;
  readonly platform: string;
  readonly sessionId: string;
  readonly source: string;
}

export function logRecordToDiagnosticEvent(
  record: LogRecord,
  env: DiagnosticEventEnv
): DiagnosticEvent | null {
  const severity = SEVERITY_BY_LEVEL[record.level];
  if (!severity) {
    return null;
  }

  let stack: string | null = null;
  let causeChain: readonly DiagnosticCauseEntry[] | null = null;
  const context: Record<string, unknown> = {};

  for (const arg of record.args) {
    if (arg instanceof Error) {
      stack ??= arg.stack ? boundWithMarker(arg.stack, DIAGNOSTIC_STACK_MAX_CHARS) : null;
      const chain = walkCauseChain(arg);
      causeChain ??= chain.length > 0 ? chain : null;
      context['errorName'] = arg.name;
      context['errorMessage'] = boundWithMarker(arg.message, DIAGNOSTIC_MESSAGE_MAX_CHARS);
    } else if (isRecord(arg)) {
      Object.assign(context, arg);
    }
  }

  const code = readString(context, 'code');
  const message = boundWithMarker(
    record.message ?? (typeof record.args[0] === 'string' ? record.args[0] : ''),
    DIAGNOSTIC_MESSAGE_MAX_CHARS
  );

  const redacted = redactSensitiveLogValue(context) as Record<string, unknown>;
  const serialized = JSON.stringify(redacted);
  const boundedContext =
    serialized.length > DIAGNOSTIC_CONTEXT_MAX_CHARS
      ? { truncatedContext: boundWithMarker(serialized, DIAGNOSTIC_CONTEXT_MAX_CHARS) }
      : redacted;

  return {
    appVersion: env.appVersion,
    causeChain,
    code,
    context: Object.keys(boundedContext).length > 0 ? boundedContext : null,
    fingerprint: computeDiagnosticFingerprint(code, record.scope ?? null, message),
    id: env.makeId(),
    message,
    occurredAt: record.timestamp,
    platform: env.platform,
    resourceId: readString(context, 'resourceId'),
    rootId: readString(context, 'rootId'),
    runId: readString(context, 'runId'),
    scope: record.scope ?? null,
    sessionId: env.sessionId,
    severity,
    source: env.source,
    stack,
    threadId: readString(context, 'threadId'),
  };
}
```

If `redactSensitiveLogValue` is not currently exported from `packages/utils/src/logger.ts`, add `export` to its declaration (it exists — the platform contract documents it). Add the `./diagnostics` subpath to `packages/utils/package.json` exports, copying the `./logger` entry's shape.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @brainstrike/utils vitest run src/__tests__/diagnostic-events.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Lint, type-check, commit**

```bash
pnpm dlx ultracite fix packages/utils/src/diagnostics/diagnostic-events.ts packages/utils/src/__tests__/diagnostic-events.test.ts
pnpm --filter @brainstrike/utils type-check
git add packages/utils
git commit -m "feat(diagnostics): diagnostic event contract + fingerprint (BST flight-recorder P1)"
```

---

### Task 2: Migration 072 — `brainstrike_diagnostic_events`

**Files:**
- Create: `packages/db/src/migrations/072-diagnostic-events.ts`
- Modify: `packages/db/src/migrations/index.ts` (import + append `migration072DiagnosticEvents` to the array after `migration071…`)
- Modify: `packages/db/src/drizzle/migrate.ts` (import + `customMigration('custom-072-diagnostic-events', migration072DiagnosticEvents)` appended after the 071 entry)
- Test: `packages/db/__tests__/migration-072-diagnostic-events.test.ts`

**Interfaces:**
- Produces: table `brainstrike_diagnostic_events` with the exact columns below; later tasks insert/select against them.
- The lane manifest needs NO change: `/^migration-/` already matches the test filename (verify in Step 4).

- [ ] **Step 1: Write the failing test** (mirrors `migration-068-tool-output-artifacts.test.ts` harness)

```ts
// packages/db/__tests__/migration-072-diagnostic-events.test.ts
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

describe('migration 072: diagnostic events', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-diagnostic-events');
    db = await wasmLoader.createPGlite(dataDir);
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version < 72));
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration072() {
    const migration = migrations.find((candidate) => candidate.version === 72);
    if (!migration) {
      throw new Error('Migration 072 is missing');
    }
    return migration;
  }

  it('creates the table with severity check and lifecycle indexes', async () => {
    await runner.runMigration(getMigration072());

    const table = await db.query<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count FROM information_schema.tables
       WHERE table_name = 'brainstrike_diagnostic_events'`
    );
    expect(Number(table.rows[0]?.count ?? 0)).toBe(1);

    const indexes = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'brainstrike_diagnostic_events'`
    );
    const names = indexes.rows.map((row) => row.indexname);
    expect(names).toContain('bst_diagnostic_events_occurred_idx');
    expect(names).toContain('bst_diagnostic_events_fingerprint_idx');
    expect(names).toContain('bst_diagnostic_events_thread_idx');
    expect(names).toContain('bst_diagnostic_events_severity_idx');

    await expect(
      db.query(
        `INSERT INTO brainstrike_diagnostic_events
           (id, occurred_at, severity, source, message, fingerprint, session_id, app_version, platform)
         VALUES ('e1', NOW(), 'info', 'web-renderer', 'm', 'f', 's', 'v', 'p')`
      )
    ).rejects.toThrow(); // severity check: warn|error|fatal only
  });

  it('round-trips down/up idempotently', async () => {
    const migration = getMigration072();
    await runner.runMigration(migration);
    await db.exec(migration.down);
    await runner.runMigration(migration);
    const table = await db.query<{ count: number | string }>(
      `SELECT COUNT(*)::int AS count FROM information_schema.tables
       WHERE table_name = 'brainstrike_diagnostic_events'`
    );
    expect(Number(table.rows[0]?.count ?? 0)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @brainstrike/db vitest run __tests__/migration-072-diagnostic-events.test.ts`
Expected: FAIL — "Migration 072 is missing".

- [ ] **Step 3: Write the migration + register in BOTH runners**

```ts
// packages/db/src/migrations/072-diagnostic-events.ts
import type { Migration } from './migration-runner';

/**
 * Flight Recorder P1: durable app-wide diagnostic events (warn+).
 *
 * Cross-cutting store, deliberately SEPARATE from the run-scoped
 * `brainstrike_assistant_run_events` timeline (different scope, retention,
 * and sanitization contract — design doc §3C, "do not relitigate").
 *
 * NO foreign keys (run_usage 046 / run_outcomes 062 precedent): both
 * migration runners execute on a bare PGlite; correlation ids are nullable
 * text and orphans are inert. Retention is a bounded oldest-first purge in
 * DiagnosticEventsRepository (30d / 20k rows), NOT a trigger. Factory reset
 * purges explicitly (db-ipc OptionalRelationTable + web db-provider reset).
 */
export const migration072DiagnosticEvents: Migration = {
  down: `
    DROP INDEX IF EXISTS bst_diagnostic_events_severity_idx;
    --> statement-breakpoint
    DROP INDEX IF EXISTS bst_diagnostic_events_thread_idx;
    --> statement-breakpoint
    DROP INDEX IF EXISTS bst_diagnostic_events_fingerprint_idx;
    --> statement-breakpoint
    DROP INDEX IF EXISTS bst_diagnostic_events_occurred_idx;
    --> statement-breakpoint
    DROP TABLE IF EXISTS brainstrike_diagnostic_events;
  `,
  name: 'diagnostic_events',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_diagnostic_events (
      id          text PRIMARY KEY,
      occurred_at timestamptz NOT NULL,
      severity    text NOT NULL CHECK (severity IN ('warn','error','fatal')),
      source      text NOT NULL,
      scope       text,
      code        text,
      message     text NOT NULL,
      stack       text,
      cause_chain jsonb,
      context     jsonb,
      fingerprint text NOT NULL,
      session_id  text NOT NULL,
      run_id      text,
      thread_id   text,
      resource_id text,
      root_id     text,
      app_version text NOT NULL,
      platform    text NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT NOW()
    );
    --> statement-breakpoint
    CREATE INDEX IF NOT EXISTS bst_diagnostic_events_occurred_idx
      ON brainstrike_diagnostic_events (occurred_at DESC);
    --> statement-breakpoint
    CREATE INDEX IF NOT EXISTS bst_diagnostic_events_fingerprint_idx
      ON brainstrike_diagnostic_events (fingerprint, occurred_at DESC);
    --> statement-breakpoint
    CREATE INDEX IF NOT EXISTS bst_diagnostic_events_thread_idx
      ON brainstrike_diagnostic_events (thread_id) WHERE thread_id IS NOT NULL;
    --> statement-breakpoint
    CREATE INDEX IF NOT EXISTS bst_diagnostic_events_severity_idx
      ON brainstrike_diagnostic_events (severity, occurred_at DESC);
  `,
  version: 72,
};
```

In `packages/db/src/migrations/index.ts`: add `import { migration072DiagnosticEvents } from './072-diagnostic-events.js';` beside the 071 import and append `migration072DiagnosticEvents,` to the migrations array (after the 071 entry — match the file's existing ordering).

In `packages/db/src/drizzle/migrate.ts`: add the same import and append `customMigration('custom-072-diagnostic-events', migration072DiagnosticEvents),` after the 071 `customMigration` line.

- [ ] **Step 4: Run tests to verify pass + lane assignment**

Run: `pnpm --filter @brainstrike/db vitest run __tests__/migration-072-diagnostic-events.test.ts __tests__/db-test-lane-manifest.test.ts __tests__/drizzle-migrate.test.ts`
Expected: PASS. The lane-manifest test proves `/^migration-/` claims the new file (no manifest edit needed); `drizzle-migrate` proves the custom migration registers.

- [ ] **Step 5: Lint + commit**

```bash
pnpm dlx ultracite fix packages/db/src/migrations packages/db/src/drizzle/migrate.ts packages/db/__tests__/migration-072-diagnostic-events.test.ts
git add packages/db
git commit -m "feat(db): migration 072 brainstrike_diagnostic_events (dual-runner)"
```

---

### Task 3: DiagnosticEventsRepository

**Files:**
- Create: `packages/db/src/repositories/diagnostic-events-repository.ts`
- Modify: `packages/db/src/repositories/index.ts` (re-export the new module, matching how `tool-output-artifact-repository` is exported)
- Test: `packages/db/__tests__/diagnostic-events-repository.test.ts` (matches the `/repository\.test\.ts$/` lane regex — no manifest edit)

**Interfaces:**
- Consumes: `DiagnosticEvent`, `DiagnosticSeverity` from `@brainstrike/utils/diagnostics` (Task 1); a `{ query<T>(sql, params?): Promise<{ rows: T[] }> }` database (the `ToolOutputArtifactDatabase` shape — reuse by defining `export interface DiagnosticEventsDatabase` identically).
- Produces (Tasks 5/8 depend on these exact signatures):
  - `class DiagnosticEventsRepository { constructor(db: DiagnosticEventsDatabase, options?: { now?: () => Date }) }`
  - `insertBatch(events: readonly DiagnosticEvent[]): Promise<void>`
  - `queryEvents(filter: { severity?: DiagnosticSeverity; sinceMs?: number; untilMs?: number; threadId?: string; runId?: string; fingerprint?: string; limit?: number }): Promise<DiagnosticEvent[]>` (ordered `occurred_at DESC`, default/max limit 200)
  - `countByFingerprint(fingerprint: string, sinceMs: number): Promise<{ count: number; firstSeenMs: number | null; lastSeenMs: number | null }>`
  - `purge(options?: { maxAgeMs?: number; maxRows?: number; limit?: number }): Promise<number>` — defaults `DIAGNOSTIC_RETENTION_MAX_AGE_MS = 30*24*60*60*1000`, `DIAGNOSTIC_RETENTION_MAX_ROWS = 20_000`, batch limit 500; deletes oldest-first beyond either bound; returns deleted count.
  - `export class DiagnosticEventsStorageError extends Error` with `operation: 'insert' | 'purge' | 'query'` (mirror `ToolOutputArtifactStorageError` exactly).

- [ ] **Step 1: Write the failing test** (real PGlite via the migration harness)

```ts
// packages/db/__tests__/diagnostic-events-repository.test.ts
import type { PGlite } from '@electric-sql/pglite';
import type { DiagnosticEvent } from '@brainstrike/utils/diagnostics';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import {
  DIAGNOSTIC_RETENTION_MAX_ROWS,
  DiagnosticEventsRepository,
} from '../src/repositories/diagnostic-events-repository.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

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
    const dataDir = createPGliteTestDataDir('pglite-test-diagnostic-repo');
    db = await wasmLoader.createPGlite(dataDir);
    const runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations);
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @brainstrike/db vitest run __tests__/diagnostic-events-repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// packages/db/src/repositories/diagnostic-events-repository.ts
import type { DiagnosticEvent, DiagnosticSeverity } from '@brainstrike/utils/diagnostics';

const TABLE = 'brainstrike_diagnostic_events';

export const DIAGNOSTIC_RETENTION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const DIAGNOSTIC_RETENTION_MAX_ROWS = 20_000;
const DEFAULT_PURGE_LIMIT = 500;
const DEFAULT_QUERY_LIMIT = 200;

export type DiagnosticEventsOperation = 'insert' | 'purge' | 'query';

export class DiagnosticEventsStorageError extends Error {
  readonly operation: DiagnosticEventsOperation;

  constructor(operation: DiagnosticEventsOperation, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to ${operation} diagnostic events${detail ? `: ${detail}` : ''}`, { cause });
    this.name = 'DiagnosticEventsStorageError';
    this.operation = operation;
  }
}

export interface DiagnosticEventsDatabase {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface DiagnosticEventsQueryFilter {
  readonly fingerprint?: string;
  readonly limit?: number;
  readonly runId?: string;
  readonly severity?: DiagnosticSeverity;
  readonly sinceMs?: number;
  readonly threadId?: string;
  readonly untilMs?: number;
}

interface DiagnosticEventRow {
  app_version: string;
  cause_chain: unknown;
  code: string | null;
  context: unknown;
  fingerprint: string;
  id: string;
  message: string;
  occurred_at: string | Date;
  platform: string;
  resource_id: string | null;
  root_id: string | null;
  run_id: string | null;
  scope: string | null;
  session_id: string;
  severity: DiagnosticSeverity;
  source: string;
  stack: string | null;
  thread_id: string | null;
}

function toMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function mapRow(row: DiagnosticEventRow): DiagnosticEvent {
  return {
    appVersion: row.app_version,
    causeChain: Array.isArray(row.cause_chain)
      ? (row.cause_chain as DiagnosticEvent['causeChain'])
      : null,
    code: row.code,
    context:
      row.context && typeof row.context === 'object' && !Array.isArray(row.context)
        ? (row.context as Record<string, unknown>)
        : null,
    fingerprint: row.fingerprint,
    id: row.id,
    message: row.message,
    occurredAt: toMs(row.occurred_at),
    platform: row.platform,
    resourceId: row.resource_id,
    rootId: row.root_id,
    runId: row.run_id,
    scope: row.scope,
    sessionId: row.session_id,
    severity: row.severity,
    source: row.source,
    stack: row.stack,
    threadId: row.thread_id,
  };
}

export class DiagnosticEventsRepository {
  private readonly db: DiagnosticEventsDatabase;
  private readonly now: () => Date;

  constructor(db: DiagnosticEventsDatabase, options?: { now?: () => Date }) {
    this.db = db;
    this.now = options?.now ?? (() => new Date());
  }

  async insertBatch(events: readonly DiagnosticEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    const columns =
      '(id, occurred_at, severity, source, scope, code, message, stack, cause_chain, context, fingerprint, session_id, run_id, thread_id, resource_id, root_id, app_version, platform)';
    const params: unknown[] = [];
    const tuples = events.map((event, index) => {
      const base = index * 18;
      params.push(
        event.id,
        new Date(event.occurredAt).toISOString(),
        event.severity,
        event.source,
        event.scope,
        event.code,
        event.message,
        event.stack,
        event.causeChain ? JSON.stringify(event.causeChain) : null,
        event.context ? JSON.stringify(event.context) : null,
        event.fingerprint,
        event.sessionId,
        event.runId,
        event.threadId,
        event.resourceId,
        event.rootId,
        event.appVersion,
        event.platform
      );
      const placeholders = Array.from({ length: 18 }, (_, offset) => `$${base + offset + 1}`);
      return `(${placeholders.join(', ')})`;
    });
    try {
      await this.db.query(
        `INSERT INTO ${TABLE} ${columns} VALUES ${tuples.join(', ')} ON CONFLICT (id) DO NOTHING`,
        params
      );
    } catch (error) {
      throw new DiagnosticEventsStorageError('insert', error);
    }
  }

  async queryEvents(filter: DiagnosticEventsQueryFilter): Promise<DiagnosticEvent[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const push = (clause: string, value: unknown) => {
      params.push(value);
      clauses.push(clause.replace('?', `$${params.length}`));
    };
    if (filter.severity) {
      push('severity = ?', filter.severity);
    }
    if (filter.threadId) {
      push('thread_id = ?', filter.threadId);
    }
    if (filter.runId) {
      push('run_id = ?', filter.runId);
    }
    if (filter.fingerprint) {
      push('fingerprint = ?', filter.fingerprint);
    }
    if (typeof filter.sinceMs === 'number') {
      push('occurred_at >= ?', new Date(filter.sinceMs).toISOString());
    }
    if (typeof filter.untilMs === 'number') {
      push('occurred_at <= ?', new Date(filter.untilMs).toISOString());
    }
    const limit = Math.min(Math.max(filter.limit ?? DEFAULT_QUERY_LIMIT, 1), DEFAULT_QUERY_LIMIT);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    try {
      const result = await this.db.query<DiagnosticEventRow>(
        `SELECT * FROM ${TABLE} ${where} ORDER BY occurred_at DESC, id DESC LIMIT ${limit}`,
        params
      );
      return result.rows.map(mapRow);
    } catch (error) {
      throw new DiagnosticEventsStorageError('query', error);
    }
  }

  async countByFingerprint(
    fingerprint: string,
    sinceMs: number
  ): Promise<{ count: number; firstSeenMs: number | null; lastSeenMs: number | null }> {
    try {
      const result = await this.db.query<{
        count: number | string;
        first_seen: string | Date | null;
        last_seen: string | Date | null;
      }>(
        `SELECT COUNT(*)::int AS count, MIN(occurred_at) AS first_seen, MAX(occurred_at) AS last_seen
         FROM ${TABLE} WHERE fingerprint = $1 AND occurred_at >= $2`,
        [fingerprint, new Date(sinceMs).toISOString()]
      );
      const row = result.rows[0];
      return {
        count: Number(row?.count ?? 0),
        firstSeenMs: row?.first_seen ? toMs(row.first_seen) : null,
        lastSeenMs: row?.last_seen ? toMs(row.last_seen) : null,
      };
    } catch (error) {
      throw new DiagnosticEventsStorageError('query', error);
    }
  }

  /** Bounded oldest-first purge past the age OR row bound. Never an unbounded DELETE. */
  async purge(options?: {
    maxAgeMs?: number;
    maxRows?: number;
    limit?: number;
  }): Promise<number> {
    const maxAgeMs = options?.maxAgeMs ?? DIAGNOSTIC_RETENTION_MAX_AGE_MS;
    const maxRows = options?.maxRows ?? DIAGNOSTIC_RETENTION_MAX_ROWS;
    const limit = options?.limit ?? DEFAULT_PURGE_LIMIT;
    const cutoff = new Date(this.now().getTime() - maxAgeMs).toISOString();
    try {
      const aged = await this.db.query<{ id: string }>(
        `DELETE FROM ${TABLE} WHERE id IN (
           SELECT id FROM ${TABLE} WHERE occurred_at < $1 ORDER BY occurred_at ASC LIMIT ${limit}
         ) RETURNING id`,
        [cutoff]
      );
      const overCap = await this.db.query<{ id: string }>(
        `DELETE FROM ${TABLE} WHERE id IN (
           SELECT id FROM ${TABLE} ORDER BY occurred_at DESC, id DESC OFFSET $1 LIMIT ${limit}
         ) RETURNING id`,
        [maxRows]
      );
      return aged.rows.length + overCap.rows.length;
    } catch (error) {
      throw new DiagnosticEventsStorageError('purge', error);
    }
  }
}
```

Re-export from `packages/db/src/repositories/index.ts` following the existing export style for `tool-output-artifact-repository`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @brainstrike/db vitest run __tests__/diagnostic-events-repository.test.ts __tests__/db-test-lane-manifest.test.ts`
Expected: PASS (repository lane claims the file automatically).

- [ ] **Step 5: Lint + commit**

```bash
pnpm dlx ultracite fix packages/db/src/repositories packages/db/__tests__/diagnostic-events-repository.test.ts
git add packages/db
git commit -m "feat(db): DiagnosticEventsRepository (insert/query/fingerprint/purge)"
```

---

### Task 4: DiagnosticEventWriter (pure batching, loud loss)

**Files:**
- Create: `packages/utils/src/diagnostics/diagnostic-event-writer.ts`
- Test: `packages/utils/src/__tests__/diagnostic-event-writer.test.ts`

**Interfaces:**
- Consumes: `DiagnosticEvent` (Task 1).
- Produces (Task 5 depends on):
  - `interface DiagnosticEventSink { insertBatch(events: readonly DiagnosticEvent[]): Promise<void> }`
  - `class DiagnosticEventWriter { constructor(options: { sink: DiagnosticEventSink; makeDroppedEvent: (droppedCount: number) => DiagnosticEvent; flushIntervalMs?: number; flushBatchSize?: number; maxPending?: number; maxConsecutiveFailures?: number; onDisabled?: (cause: unknown) => void; setInterval?: typeof setInterval; clearInterval?: typeof clearInterval }) }`
  - `enqueue(event: DiagnosticEvent): void` (sync, never throws)
  - `flush(): Promise<void>` ; `dispose(): Promise<void>` (final flush + stop timer)
  - `get disabled(): boolean`
  - Defaults: `flushIntervalMs 2000`, `flushBatchSize 32`, `maxPending 256`, `maxConsecutiveFailures 5`.

Semantics (design §4.3): enqueue past `maxPending` drops OLDEST and increments a counter; the next successful flush prepends one `makeDroppedEvent(count)` event and resets the counter (loud loss). After `maxConsecutiveFailures` failed flushes the writer disables itself, calls `onDisabled(cause)` once, and `enqueue` becomes a no-op (honest degradation — the caller surfaces it). A flush triggered while one is in flight coalesces (single-flight).

- [ ] **Step 1: Write the failing test**

```ts
// packages/utils/src/__tests__/diagnostic-event-writer.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticEventWriter } from '../diagnostics/diagnostic-event-writer';
import type { DiagnosticEvent } from '../diagnostics/diagnostic-events';

function makeEvent(id: string): DiagnosticEvent {
  return {
    appVersion: 'v', causeChain: null, code: null, context: null,
    fingerprint: 'f', id, message: 'm', occurredAt: 1, platform: 'p',
    resourceId: null, rootId: null, runId: null, scope: null,
    sessionId: 's', severity: 'error', source: 'test', stack: null, threadId: null,
  };
}

describe('DiagnosticEventWriter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('flushes on the batch-size threshold', async () => {
    const inserted: DiagnosticEvent[][] = [];
    const writer = new DiagnosticEventWriter({
      flushBatchSize: 2,
      makeDroppedEvent: (count) => makeEvent(`dropped-${count}`),
      sink: { insertBatch: async (events) => void inserted.push([...events]) },
    });
    writer.enqueue(makeEvent('a'));
    writer.enqueue(makeEvent('b'));
    await vi.runOnlyPendingTimersAsync();
    expect(inserted.flat().map((event) => event.id)).toEqual(['a', 'b']);
    await writer.dispose();
  });

  it('flushes on the interval', async () => {
    const inserted: DiagnosticEvent[] = [];
    const writer = new DiagnosticEventWriter({
      makeDroppedEvent: (count) => makeEvent(`dropped-${count}`),
      sink: { insertBatch: async (events) => void inserted.push(...events) },
    });
    writer.enqueue(makeEvent('a'));
    await vi.advanceTimersByTimeAsync(2001);
    expect(inserted.map((event) => event.id)).toEqual(['a']);
    await writer.dispose();
  });

  it('drops oldest past maxPending and reports the loss loudly', async () => {
    const inserted: DiagnosticEvent[] = [];
    const writer = new DiagnosticEventWriter({
      flushIntervalMs: 60_000,
      makeDroppedEvent: (count) => makeEvent(`dropped-${count}`),
      maxPending: 2,
      sink: { insertBatch: async (events) => void inserted.push(...events) },
    });
    writer.enqueue(makeEvent('a'));
    writer.enqueue(makeEvent('b'));
    writer.enqueue(makeEvent('c')); // drops 'a'
    await writer.flush();
    expect(inserted.map((event) => event.id)).toEqual(['dropped-1', 'b', 'c']);
    await writer.dispose();
  });

  it('disables after maxConsecutiveFailures and reports once', async () => {
    const onDisabled = vi.fn();
    const writer = new DiagnosticEventWriter({
      makeDroppedEvent: (count) => makeEvent(`dropped-${count}`),
      maxConsecutiveFailures: 2,
      onDisabled,
      sink: { insertBatch: async () => { throw new Error('db down'); } },
    });
    writer.enqueue(makeEvent('a'));
    await writer.flush();
    expect(writer.disabled).toBe(false);
    await writer.flush();
    expect(writer.disabled).toBe(true);
    expect(onDisabled).toHaveBeenCalledTimes(1);
    writer.enqueue(makeEvent('b')); // no-op, must not throw
    await writer.dispose();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @brainstrike/utils vitest run src/__tests__/diagnostic-event-writer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// packages/utils/src/diagnostics/diagnostic-event-writer.ts
import type { DiagnosticEvent } from './diagnostic-events';

export interface DiagnosticEventSink {
  insertBatch(events: readonly DiagnosticEvent[]): Promise<void>;
}

export interface DiagnosticEventWriterOptions {
  readonly clearInterval?: typeof globalThis.clearInterval;
  readonly flushBatchSize?: number;
  readonly flushIntervalMs?: number;
  readonly makeDroppedEvent: (droppedCount: number) => DiagnosticEvent;
  readonly maxConsecutiveFailures?: number;
  readonly maxPending?: number;
  readonly onDisabled?: (cause: unknown) => void;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly sink: DiagnosticEventSink;
}

export class DiagnosticEventWriter {
  private readonly options: Required<
    Pick<DiagnosticEventWriterOptions, 'flushBatchSize' | 'flushIntervalMs' | 'maxConsecutiveFailures' | 'maxPending'>
  > &
    DiagnosticEventWriterOptions;
  private pending: DiagnosticEvent[] = [];
  private droppedCount = 0;
  private consecutiveFailures = 0;
  private isDisabled = false;
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: DiagnosticEventWriterOptions) {
    this.options = {
      flushBatchSize: 32,
      flushIntervalMs: 2000,
      maxConsecutiveFailures: 5,
      maxPending: 256,
      ...options,
    };
    const schedule = this.options.setInterval ?? globalThis.setInterval.bind(globalThis);
    this.timer = schedule(() => {
      void this.flush();
    }, this.options.flushIntervalMs);
  }

  get disabled(): boolean {
    return this.isDisabled;
  }

  enqueue(event: DiagnosticEvent): void {
    if (this.isDisabled) {
      return;
    }
    this.pending.push(event);
    while (this.pending.length > this.options.maxPending) {
      this.pending.shift();
      this.droppedCount += 1;
    }
    if (this.pending.length >= this.options.flushBatchSize) {
      void this.flush();
    }
  }

  flush(): Promise<void> {
    this.inFlight ??= this.flushInternal().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async flushInternal(): Promise<void> {
    if (this.isDisabled || (this.pending.length === 0 && this.droppedCount === 0)) {
      return;
    }
    const batch = this.pending;
    this.pending = [];
    const dropped = this.droppedCount;
    this.droppedCount = 0;
    const events = dropped > 0 ? [this.options.makeDroppedEvent(dropped), ...batch] : batch;
    try {
      await this.options.sink.insertBatch(events);
      this.consecutiveFailures = 0;
    } catch (cause) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.options.maxConsecutiveFailures) {
        this.isDisabled = true;
        this.pending = [];
        this.options.onDisabled?.(cause);
      } else {
        // Re-queue in front so order is preserved; the drop bound still applies.
        this.pending = [...events, ...this.pending];
        while (this.pending.length > this.options.maxPending) {
          this.pending.shift();
          this.droppedCount += 1;
        }
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.timer !== null) {
      (this.options.clearInterval ?? globalThis.clearInterval.bind(globalThis))(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @brainstrike/utils vitest run src/__tests__/diagnostic-event-writer.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
pnpm dlx ultracite fix packages/utils/src/diagnostics packages/utils/src/__tests__/diagnostic-event-writer.test.ts
git add packages/utils
git commit -m "feat(diagnostics): batched DiagnosticEventWriter with loud loss + honest disable"
```

---

### Task 5: Renderer sink bridge (capture wiring) + factory reset

**Files:**
- Create: `packages/app-shell/src/diagnostics/diagnostic-sink-bridge.tsx`
- Modify: `apps/web/src/main.tsx` (mount `<DiagnosticSinkBridge source="web-renderer" />` as a child inside `<DbProvider …>` at the existing line ~213 mount)
- Modify: `apps/desktop/src/renderer/main.tsx` (mount `<DiagnosticSinkBridge source="desktop-renderer" />` inside `<DbProvider …>` at line ~359; do NOT touch `embedding-host-app.tsx` or other hidden hosts — visible renderer only, by composition)
- Modify: `apps/desktop/src/ipc-domains/db-ipc.ts` — add `'brainstrike_diagnostic_events'` to the `OptionalRelationTable` union (~line 78) and `await clearOptionalRelation(tx, 'brainstrike_diagnostic_events');` beside the tool-output-artifacts line (~757), with a FACTORY RESET CONTRACT comment matching neighbors.
- Modify: `packages/db/src/db-provider.tsx` — add `'brainstrike_diagnostic_events'` to the reset table list at line ~97.
- Test: `packages/app-shell/src/__tests__/diagnostic-sink-bridge.test.tsx`
- Test (modify): the existing desktop clearAll expectations — find with `grep -rn "brainstrike_assistant_tool_output_artifacts" apps/desktop/src/__tests__` and add the new table to the same assertion lists.

**Interfaces:**
- Consumes: `useOptionalPGliteDatabase()` from `@brainstrike/db` (returns `DbHandle | null`; `DbHandle.query` satisfies `DiagnosticEventsDatabase`); `addLogListener`, `LogLevel` from `@brainstrike/utils/logger`; Task 1 converter; Task 3 repository; Task 4 writer.
- Produces: `DiagnosticSinkBridge({ source }: { source: string }): null` — render-nothing component; also exports `DIAGNOSTIC_SINK_SCOPE = 'DiagnosticSink'` (the loop-guard scope) and `getDiagnosticSessionId(): string` (module-level `crypto.randomUUID()` memo) for Task 8's environment section.

Behavior:
1. On mount with a non-null db: construct repository + writer (`makeDroppedEvent` builds a `severity:'warn'`, `code:'diagnostics_events_dropped'`, scope `DIAGNOSTIC_SINK_SCOPE` event; `onDisabled` logs ONE `logger.error` via a `createLogger(DIAGNOSTIC_SINK_SCOPE)` — which the loop guard below keeps out of the sink).
2. Subscribe `addLogListener`: skip records where `record.scope === DIAGNOSTIC_SINK_SCOPE` (loop guard) or converter returns null (below floor); otherwise `writer.enqueue(event)`.
3. Fire-and-forget `repo.purge()` once on mount (startup retention).
4. `visibilitychange` → `document.visibilityState === 'hidden'` ⇒ `void writer.flush()`; unmount ⇒ unsubscribe + `void writer.dispose()`.
5. `appVersion`: read from `import.meta.env?.VITE_APP_VERSION ?? 'dev'`; `platform`: `navigator.platform ?? 'unknown'` — both passed through the converter env.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/app-shell/src/__tests__/diagnostic-sink-bridge.test.tsx
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { error as logError, LogLevel } from '@brainstrike/utils/logger';
import { DiagnosticSinkBridge } from '../diagnostics/diagnostic-sink-bridge';

// Mock the db context to hand the bridge an in-memory query recorder.
const queries: { sql: string; params?: unknown[] }[] = [];
vi.mock('@brainstrike/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOptionalPGliteDatabase: () => ({
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ params, sql });
      return { rows: [] };
    },
  }),
}));

describe('DiagnosticSinkBridge', () => {
  it('captures a warn+ log record into the diagnostic events table', async () => {
    render(<DiagnosticSinkBridge source="web-renderer" />);
    logError('bridge test failure', { code: 'bridge_test' });
    // flushBatchSize is 32; force the interval flush via the bridge's dispose-on-unmount.
    await vi.waitFor(() => {
      const insert = queries.find((entry) => entry.sql.includes('INSERT INTO brainstrike_diagnostic_events'));
      expect(insert).toBeDefined();
      expect(JSON.stringify(insert?.params)).toContain('bridge_test');
    });
  });

  it('runs the startup retention purge', async () => {
    render(<DiagnosticSinkBridge source="web-renderer" />);
    await vi.waitFor(() => {
      expect(queries.some((entry) => entry.sql.includes('DELETE FROM brainstrike_diagnostic_events'))).toBe(true);
    });
  });
});
```

Note for the implementer: to make the first assertion deterministic without waiting 2s, construct the writer with `flushBatchSize: 1` when `process.env.NODE_ENV === 'test'` is NOT the mechanism — instead expose an optional `flushBatchSize` prop on the bridge (default undefined → writer default) and pass `flushBatchSize={1}` in the test render. Update the test render call accordingly: `render(<DiagnosticSinkBridge flushBatchSize={1} source="web-renderer" />)`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @brainstrike/app-shell vitest run src/__tests__/diagnostic-sink-bridge.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```tsx
// packages/app-shell/src/diagnostics/diagnostic-sink-bridge.tsx
import { DiagnosticEventsRepository } from '@brainstrike/db';
import {
  type DiagnosticEvent,
  logRecordToDiagnosticEvent,
} from '@brainstrike/utils/diagnostics';
import { DiagnosticEventWriter } from '@brainstrike/utils/diagnostics/diagnostic-event-writer';
import { addLogListener, createLogger } from '@brainstrike/utils/logger';
import { useEffect } from 'react';
import { useOptionalPGliteDatabase } from '@brainstrike/db';

export const DIAGNOSTIC_SINK_SCOPE = 'DiagnosticSink';

let sessionId: string | null = null;
export function getDiagnosticSessionId(): string {
  sessionId ??= crypto.randomUUID();
  return sessionId;
}

const bridgeLogger = createLogger(DIAGNOSTIC_SINK_SCOPE);

function makeDroppedEvent(source: string) {
  return (droppedCount: number): DiagnosticEvent => ({
    appVersion: readAppVersion(),
    causeChain: null,
    code: 'diagnostics_events_dropped',
    context: { droppedCount },
    fingerprint: 'diagnostics_events_dropped',
    id: crypto.randomUUID(),
    message: `Diagnostic sink overflow: dropped ${droppedCount} events before this flush.`,
    occurredAt: Date.now(),
    platform: readPlatform(),
    resourceId: null,
    rootId: null,
    runId: null,
    scope: DIAGNOSTIC_SINK_SCOPE,
    sessionId: getDiagnosticSessionId(),
    severity: 'warn',
    source,
    stack: null,
    threadId: null,
  });
}

function readAppVersion(): string {
  const env = (import.meta as { env?: Record<string, unknown> }).env;
  return typeof env?.['VITE_APP_VERSION'] === 'string' ? (env['VITE_APP_VERSION'] as string) : 'dev';
}

function readPlatform(): string {
  return typeof navigator !== 'undefined' && navigator.platform ? navigator.platform : 'unknown';
}

export interface DiagnosticSinkBridgeProps {
  readonly flushBatchSize?: number;
  readonly source: string;
}

/** Render-nothing bridge: logger fan-out → batched writer → PGlite (design §4.3).
 * Mounted ONLY in the visible web + desktop renderers (capability by composition —
 * hidden hosts never mount it). */
export function DiagnosticSinkBridge({ flushBatchSize, source }: DiagnosticSinkBridgeProps): null {
  const db = useOptionalPGliteDatabase();

  useEffect(() => {
    if (!db) {
      return;
    }
    const repository = new DiagnosticEventsRepository(db);
    const writer = new DiagnosticEventWriter({
      flushBatchSize,
      makeDroppedEvent: makeDroppedEvent(source),
      onDisabled: (cause) => {
        // Loop guard: this scope is excluded from capture below, so the sink
        // failure is loud (console/file) without recursing into the sink.
        bridgeLogger.error('Diagnostic event sink disabled after repeated flush failures', {
          cause: cause instanceof Error ? cause.message : String(cause),
        });
      },
      sink: repository,
    });
    const env = {
      appVersion: readAppVersion(),
      makeId: () => crypto.randomUUID(),
      platform: readPlatform(),
      sessionId: getDiagnosticSessionId(),
      source,
    };
    const unsubscribe = addLogListener((record) => {
      if (record.scope === DIAGNOSTIC_SINK_SCOPE) {
        return;
      }
      const event = logRecordToDiagnosticEvent(record, env);
      if (event) {
        writer.enqueue(event);
      }
    });
    repository.purge().catch((cause: unknown) => {
      bridgeLogger.error('Diagnostic retention purge failed', {
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    });
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        void writer.flush();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribe();
      void writer.dispose();
    };
  }, [db, flushBatchSize, source]);

  return null;
}
```

Adjust imports to the actual export surface: `DiagnosticEventsRepository` comes from `@brainstrike/db` only if `repositories/index.ts` is re-exported at the package root — verify with `grep -n "tool-output-artifact-repository" packages/db/src/index.ts` and import from the same path depth the artifact repository uses. Mount points: add `<DiagnosticSinkBridge source="web-renderer" />` as the first child inside `<DbProvider dbPath={webDbPath}>` in `apps/web/src/main.tsx`, and `<DiagnosticSinkBridge source="desktop-renderer" />` inside `<DbProvider dbPath={dbPath} useElectronIPC={true}>` in `apps/desktop/src/renderer/main.tsx` (visible window only — NOT the hidden-host apps).

Factory reset edits (both in this task, per the platform contract):
- `apps/desktop/src/ipc-domains/db-ipc.ts`: extend the `OptionalRelationTable` union with `| 'brainstrike_diagnostic_events'` and add beside the artifact purge:

```ts
            // Durable diagnostic events (Flight Recorder P1): warn+ error log.
            // No FK, so nothing cascades it — clear explicitly per the FACTORY
            // RESET CONTRACT so error history cannot survive a fresh start.
            await clearOptionalRelation(tx, 'brainstrike_diagnostic_events');
```

- `packages/db/src/db-provider.tsx` line ~97: change the loop list to `['brainstrike_thread_message_index', 'brainstrike_thread_search_state', 'brainstrike_diagnostic_events']`.

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @brainstrike/app-shell vitest run src/__tests__/diagnostic-sink-bridge.test.tsx`
Expected: PASS. Then run the touched desktop/db suites: `pnpm --filter @brainstrike/desktop vitest run src/__tests__/ipc-handlers-db.test.ts` and `pnpm --filter @brainstrike/db vitest run` — extend any clearAll table-list assertion that now fails to include `brainstrike_diagnostic_events` (that failure is the guard working).

- [ ] **Step 5: Lint + commit**

```bash
pnpm dlx ultracite fix packages/app-shell/src/diagnostics apps/web/src/main.tsx apps/desktop/src/renderer/main.tsx apps/desktop/src/ipc-domains/db-ipc.ts packages/db/src/db-provider.tsx
git add packages/app-shell apps/web apps/desktop packages/db
git commit -m "feat(diagnostics): renderer sink bridge + retention + factory-reset wiring"
```

---

### Task 6: Desktop main → renderer durable-record push

**Files:**
- Modify: `apps/desktop/src/platform/logging-api-contract.ts` — add `durableRecord: 'logging:durable-record'` to `LOGGING_API_CHANNELS`.
- Modify: `apps/desktop/src/logging-ipc.ts` — in `registerLoggingIpcHandlers`, tap warn+ records (main's own `addLogListener` output AND records arriving via `ingestBufferedRecord` from hidden hosts) and `webContents.send(LOGGING_API_CHANNELS.durableRecord, record)` to the visible main window only (the registrar already knows window roles from the ingest tagging — reuse the same role source; hidden hosts are excluded as senders' targets).
- Modify: `apps/desktop/src/preload.ts` — extend the existing `window.logging` bridge with `onDurableRecord(listener: (record: LogRecord) => void): () => void` using the same `ipcRenderer.on`/removeListener pattern as the existing `preferencesUpdated` subscription in that file.
- Modify: `packages/app-shell/src/diagnostics/diagnostic-sink-bridge.tsx` — accept an optional `forwardedRecords?: { subscribe(listener: (record: LogRecord & { bindings: Record<string, unknown> }) => void): () => void }` prop; when present, subscribe and enqueue via the same converter with `source` read from `record.bindings['runtime'] === 'electron-main' ? 'electron-main' : String(record.bindings['sourceWindowRole'] ?? 'hidden-host')`.
- Modify: `apps/desktop/src/renderer/main.tsx` — pass `forwardedRecords={{ subscribe: window.logging.onDurableRecord }}` (guard: only when `window.logging?.onDurableRecord` exists — older preload = no prop, capability by composition).
- Test: `apps/desktop/src/__tests__/logging-durable-record.test.ts`

**Interfaces:**
- Consumes: `LogRecord`, `LogLevel` from `@brainstrike/utils/logger`; the existing `assertLogRecord`-style validators in `logging-api-contract.ts` (reuse the ingest channel's record validation for the outbound payload).
- Produces: preload bridge method `window.logging.onDurableRecord(listener): () => void`; wire payload is a validated `LogRecord`.

- [ ] **Step 1: Write the failing test** — mirror the existing tests for `logging-ipc.ts` (locate with `grep -rn "ingestBufferedRecord\|get-buffered-logs" apps/desktop/src/__tests__ | head`). The test registers the handlers with a fake `webContents` recorder, emits one INFO and one ERROR record through the same seam the ingest handler uses, and asserts exactly the ERROR record was sent on `'logging:durable-record'`:

```ts
// apps/desktop/src/__tests__/logging-durable-record.test.ts
import { describe, expect, it } from 'vitest';
import { LogLevel } from '@brainstrike/utils/logger';
import { LOGGING_API_CHANNELS } from '../platform/logging-api-contract';
// Import the seam under test the same way the existing logging-ipc tests do —
// read that file's harness first and reuse its fake ipcMain/webContents setup.

describe('durable record push', () => {
  it('forwards only warn+ records to the visible window channel', () => {
    const sent: { channel: string; record: unknown }[] = [];
    // ...harness setup copied from the existing logging-ipc test...
    // emit INFO record  -> expect sent to NOT include it
    // emit ERROR record -> expect sent to include exactly one
    expect(sent.every((entry) => entry.channel === LOGGING_API_CHANNELS.durableRecord)).toBe(true);
    expect(LogLevel.ERROR).toBeDefined();
  });
});
```

(The concrete harness comes from the existing logging-ipc test file — copy its setup verbatim; the assertion contract above is what must hold.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @brainstrike/desktop vitest run src/__tests__/logging-durable-record.test.ts`
Expected: FAIL — `durableRecord` channel does not exist.

- [ ] **Step 3: Implement** the channel constant, the main-side warn+ tap (filter `record.level === LogLevel.WARN || LogLevel.ERROR || LogLevel.FATAL` — write it as a `Set` membership check), the preload `onDurableRecord`, the bridge prop, and the renderer wiring as specified in **Files** above. Keep the push target resolution identical to how `preferencesUpdated` finds windows in `logging-ipc.ts`.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @brainstrike/desktop vitest run src/__tests__/logging-durable-record.test.ts && pnpm --filter @brainstrike/app-shell vitest run src/__tests__/diagnostic-sink-bridge.test.tsx`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
pnpm dlx ultracite fix apps/desktop/src packages/app-shell/src/diagnostics
git add apps/desktop packages/app-shell
git commit -m "feat(desktop): push main/hidden-host warn+ records to the renderer diagnostic sink"
```

---

### Task 7: ErrorBoundary default logging

**Files:**
- Modify: `packages/ui/src/error-boundary.tsx` (`componentDidCatch`, line ~39)
- Test: extend the existing error-boundary test (locate: `grep -rn "error-boundary" packages/ui/src/__tests__ -l`)

**Interfaces:** none new — `componentDidCatch` additionally calls a module-level `createLogger('ErrorBoundary').error('React error boundary caught render error', { componentStack: errorInfo.componentStack }, error)` BEFORE invoking `props.onError`. The record flows through the Task 5 bridge automatically.

- [ ] **Step 1: Write the failing test** — in the existing error-boundary test file, add:

```tsx
it('logs the caught error through the central logger', () => {
  const records: unknown[] = [];
  const unsubscribe = addLogListener((record) => records.push(record));
  // render the boundary around a component that throws (reuse the file's existing Bomb fixture)
  expect(
    records.some(
      (record) =>
        (record as { level: LogLevel; scope?: string }).level === LogLevel.ERROR &&
        (record as { scope?: string }).scope === 'ErrorBoundary'
    )
  ).toBe(true);
  unsubscribe();
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @brainstrike/ui vitest run src/__tests__/error-boundary.test.tsx` (adjust to the actual filename). Expected: FAIL.

- [ ] **Step 3: Implement** the two-line change (module-level logger + the `componentDidCatch` call). Do not change fallback UI or `onError` semantics.

- [ ] **Step 4: Run to verify pass.** Same command; expected PASS, plus the file's pre-existing cases stay green.

- [ ] **Step 5: Commit**

```bash
pnpm dlx ultracite fix packages/ui/src/error-boundary.tsx
git add packages/ui
git commit -m "feat(ui): ErrorBoundary logs caught render errors through the central logger"
```

---

### Task 8: Debug bundle collector + formatter

**Files:**
- Create: `packages/app-shell/src/diagnostics/debug-bundle.ts`
- Test: `packages/app-shell/src/__tests__/debug-bundle.test.ts`

**Interfaces:**
- Consumes: `{ query<T>(sql, params?): Promise<{ rows: T[] }> }` (DbHandle-compatible); `DiagnosticEventsRepository` (Task 3); `redactSensitiveLogValue` (utils).
- Produces (Task 9 depends on):
  - `DEBUG_BUNDLE_FORMAT_VERSION = 1`, `DEBUG_BUNDLE_DEFAULT_MAX_BYTES = 200_000`
  - `collectThreadDebugBundleData(db: DebugBundleDatabase, input: { threadId: string; runId?: string }): Promise<ThreadDebugBundleData>`
  - `formatThreadDebugBundle(data: ThreadDebugBundleData, options?: { maxBytes?: number }): string`
  - `buildThreadDebugBundle(db, input, options?): Promise<string>` (collect → format)

`ThreadDebugBundleData` (exact shape):

```ts
export interface ThreadDebugBundleData {
  readonly diagnosticEvents: readonly DiagnosticEvent[]; // run/thread-correlated ±5min
  readonly environment: {
    readonly appVersion: string;
    readonly generatedAt: string; // ISO
    readonly platform: string;
    readonly sessionId: string;
  };
  readonly messages: readonly { readonly content: unknown; readonly createdAt: string; readonly id: string; readonly role: string }[];
  readonly priorFailures: { readonly count: number; readonly firstSeenMs: number | null; readonly lastSeenMs: number | null } | null;
  readonly run: {
    readonly completedAt: string | null;
    readonly error: string | null;
    readonly id: string;
    readonly model: string;
    readonly modelSettings: unknown;
    readonly provider: string;
    readonly providerOptions: unknown;
    readonly runtimeKind: string | null;
    readonly startedAt: string | null;
    readonly status: string;
  } | null;
  readonly runEvents: readonly { readonly detail: string | null; readonly durationMs: number | null; readonly kind: string; readonly label: string | null; readonly metadata: unknown; readonly occurredAt: string; readonly sequence: number; readonly status: string | null }[];
  readonly threadId: string;
  readonly usage: readonly { readonly billedCostUsd: string | null; readonly inputTokens: number; readonly model: string; readonly outputTokens: number; readonly provider: string }[];
}
```

Collector SQL (verbatim; `runId` optional — when absent, use the thread's LATEST `status='failed'` run, else the latest run):

```sql
-- run header
SELECT id, provider, model, model_settings, provider_options, runtime_kind,
       status, error, started_at, completed_at
FROM brainstrike_assistant_thread_runs
WHERE thread_id = $1 AND ($2::text IS NULL OR id = $2)
ORDER BY (status = 'failed') DESC, created_at DESC
LIMIT 1;

-- timeline
SELECT sequence, kind, status, label, detail, duration_ms, metadata, occurred_at
FROM brainstrike_assistant_run_events
WHERE run_id = $1 ORDER BY sequence ASC LIMIT 500;

-- usage
SELECT provider, model, input_tokens, output_tokens, billed_cost_usd
FROM brainstrike_assistant_run_usage
WHERE run_id = $1 ORDER BY created_at ASC;

-- transcript (bounded window; formatter elides further)
SELECT id, role, content, "createdAt"
FROM mastra_messages
WHERE thread_id = $1 ORDER BY "createdAt" DESC LIMIT 40;
```

(Column name caution: `mastra_messages` uses Mastra's own casing — verify `createdAt` vs `created_at` with `grep -n "createdAt" packages/assistant-contract/src/mastra-memory-schema.ts` and use whatever the schema declares.)

Diagnostic correlation: `repo.queryEvents({ runId })` UNION `repo.queryEvents({ threadId })` UNION time-window `repo.queryEvents({ sinceMs: runStart-300_000, untilMs: (runEnd ?? now)+300_000, limit: 50 })`, de-duplicated by id, capped at 100. Prior failures: if the run has a terminal diagnostic event, `countByFingerprint(fp, now - 7*24*3600*1000)`.

Formatter contract (golden-tested):
- Fixed section order 1–9 exactly as the design doc §5.2 table; header block first:

```markdown
# BrainStrike Debug Bundle
bundle_format: 1
generated_at: <ISO>
thread_id: <id>
run_id: <id | (none)>
app: <appVersion> · <platform> · session <sessionId>
```

- Sections render as `## 1. Failure summary`, `## 2. Run configuration`, … `## 9. Prior related failures`; JSON payloads in ```json fences; absent data renders an honest line (`_No failed run found for this thread._`, `_Desktop diagnostics not available on this platform._`) — never silently omitted.
- Byte budget: serialize once; if `> maxBytes`, elide in this order until under budget, re-measuring each pass: (1) oldest transcript messages beyond the failing turn ± 2 (replace each with `_[elided message <id> — <n> chars]_`), (2) tool-result bodies inside remaining messages (keep args + first 200 chars), (3) run-event `metadata` blocks (keep kind/status/detail). Each elision appends to a `## Elision log` footer listing counts — visible marker rule.
- Final pass: `redactSensitiveLogValue` over the assembled data object BEFORE formatting (belt-and-braces; sources are already redacted).

- [ ] **Step 1: Write the failing tests** — three cases: (a) golden snapshot: feed a fixed `ThreadDebugBundleData` fixture (hand-written, all 9 sections populated, fixed timestamps) → `expect(formatThreadDebugBundle(fixture)).toMatchSnapshot()`; (b) bounds: a fixture with 30 messages of 20KB each formatted with `{ maxBytes: 50_000 }` → result length ≤ 50_000, contains `Elision log`, contains `[elided message`; (c) redaction: fixture whose modelSettings contain `{ apiKey: 'sk-live-123' }` → output does not contain `sk-live-123`. Plus one collector case with a stub `query` returning canned rows per SQL shape (assert the run row, event ordering, and the failed-run-first selection).

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @brainstrike/app-shell vitest run src/__tests__/debug-bundle.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** collector + formatter exactly per the contracts above. Keep the formatter pure (no I/O, injectable `now` only through `data.environment.generatedAt`).

- [ ] **Step 4: Run to verify pass** — same command. Snapshot committed with the test.

- [ ] **Step 5: Commit**

```bash
pnpm dlx ultracite fix packages/app-shell/src/diagnostics packages/app-shell/src/__tests__/debug-bundle.test.ts
git add packages/app-shell
git commit -m "feat(diagnostics): thread debug bundle collector + bounded redacted formatter"
```

---

### Task 9: Copy-debug-bundle UI (provider seam + button)

**Files:**
- Create: `packages/ui/src/assistant-ui-panel/debug-bundle-context.tsx`
- Create: `packages/ui/src/assistant-ui-panel/copy-debug-bundle-button.tsx`
- Create: `packages/app-shell/src/hooks/use-debug-bundle.ts`
- Modify: `packages/ui/src/assistant-ui-panel/assistant-ui-panel.tsx` — render `<CopyDebugBundleButton />` immediately after `<AssistantMessageError />` (line ~1735; add the import beside the AssistantMessageError import at ~65).
- Modify: `packages/app-shell/src/assistant-ui-panel-wrapper.tsx` — mount `<DebugBundleProvider value={debugBundleBinding}>` alongside `<RunVerdictProvider …>` (line ~1576 nest), binding from the new hook.
- Test: `packages/ui/src/__tests__/copy-debug-bundle-button.test.tsx`, plus extend `packages/app-shell/src/__tests__/` with a `use-debug-bundle.test.ts`.
- Expect to update the architecture guards when they fail: `assistant-ui-panel-architecture.test.ts` (owned-module list) and `assistant-contract-boundary.test.ts` (wrapper line budget) — extending those lists IS the sanctioned mechanism (see Task Ledger precedent in `docs/agents/assistant-persistence.md`).

**Interfaces:**
- `debug-bundle-context.tsx` mirrors `run-verdict-context.tsx` exactly (read it first and copy its provider/hook/naming structure):
  - `interface DebugBundleBinding { buildBundle(input: { threadId: string; runId: string | null }): Promise<string> }`
  - `DebugBundleProvider`, `useDebugBundleContext(): DebugBundleBinding | null`
- `copy-debug-bundle-button.tsx`:
  - `CopyDebugBundleButton(): ReactElement | null` — renders null when (a) no provider binding (capability gate), or (b) the message has neither an assistant-ui error state nor a `run.failed` run-event data part. Reuse `run-verdict-control.tsx`'s message-part recognizer for run events (`ASSISTANT_RUN_EVENT_DATA_NAME`) to extract `runId` — copy its `isRecord`/part-walk helpers rather than re-inventing; the thread id comes through the binding closure (the app-shell hook already knows `selectedMemoryThreadId`), so the button passes only `runId`. Adjust `buildBundle` in the binding to `buildBundle(input: { runId: string | null })` and let app-shell supply the threadId — this keeps ui free of thread-id plumbing. Update the interface above accordingly: `DebugBundleBinding.buildBundle(input: { runId: string | null }): Promise<string>`.
  - States: idle → building (disabled, "Building…") → copied ("Copied · NN KB", reverts after 3s) → error (visible inline `Copy failed: <message>` — never silent). Copy via `navigator.clipboard.writeText(bundle)` (works in web + Electron renderer).
  - `data-testid="copy-debug-bundle"`.
- `use-debug-bundle.ts` (app-shell): `useDebugBundleBinding(): DebugBundleBinding | null` — returns null without a db handle (`useOptionalPGliteDatabase()`) or without a selected thread; otherwise `{ buildBundle: ({ runId }) => buildThreadDebugBundle(db, { runId: runId ?? undefined, threadId: selectedMemoryThreadId }) }`. Read how the wrapper obtains `selectedMemoryThreadId` (grep it in `assistant-ui-panel-wrapper.tsx`) and thread the same value.

- [ ] **Step 1: Write the failing UI test** — mirror the harness of the existing `run-verdict-control` test (find it: `grep -rn "RunVerdictControl" packages/ui/src/__tests__ -l`): render the button inside a provider with a stub binding + a message fixture carrying a `run.failed` run-event part; assert (a) hidden without provider, (b) visible with provider + failed message, (c) click → `navigator.clipboard.writeText` (spy) called with the stub bundle and the label shows `Copied`, (d) a rejecting binding shows the visible error text.

- [ ] **Step 2: Run to verify fail** — `pnpm --filter @brainstrike/ui vitest run src/__tests__/copy-debug-bundle-button.test.tsx`. Expected: FAIL.

- [ ] **Step 3: Implement** the three files + the two mounts. Match `run-verdict-control.tsx` conventions for styling and part-walking; keep the button copy exact: `Copy debug bundle` / `Building…` / `Copied · {kb} KB` / `Copy failed: {message}`.

- [ ] **Step 4: Run to verify pass + guards** — run the ui + app-shell suites: `pnpm --filter @brainstrike/ui test && pnpm --filter @brainstrike/app-shell test`. When `assistant-ui-panel-architecture.test.ts` or `assistant-contract-boundary.test.ts` fail on the new module/line-count, extend their allow-lists/budgets as those tests document inline.

- [ ] **Step 5: Commit**

```bash
pnpm dlx ultracite fix packages/ui/src/assistant-ui-panel packages/app-shell/src/hooks packages/app-shell/src/assistant-ui-panel-wrapper.tsx
git add packages/ui packages/app-shell
git commit -m "feat(assistant): Copy-debug-bundle button on failed messages (provider seam)"
```

---

### Task 10: Docs, full verification, PR update

**Files:**
- Modify: `docs/agents/platform-contracts.md` — append a `## DIAGNOSTIC EVENTS (FLIGHT RECORDER P1)` section documenting: the table + both migration runners, the warn+ listener capture seam + `DIAGNOSTIC_SINK_SCOPE` loop guard, retention defaults (30d/20k, bounded purge), factory-reset wiring (both paths), the visible-renderer-only mount rule, and the debug-bundle module map — one paragraph each, matching the file's voice.
- Modify: `docs/error-observability-design-2026-07-23.md` — change the header line `Status: PROPOSAL for review` to `Status: P1 + debug bundle IMPLEMENTED (this PR); P2/P3/P5 pending.`

- [ ] **Step 1: Make the doc edits above.**

- [ ] **Step 2: Full-repo verification in one run**

Run from the worktree root:
```bash
pnpm build && pnpm lint && pnpm type-check && pnpm test
```
Expected: all green in the same run (the AGENTS.md bar). Fix anything red before proceeding — do not skip flakes silently; if a pre-existing flake fires, re-run that package's suite once and note it in the PR body.

- [ ] **Step 3: Commit docs + push**

```bash
git add docs
git commit -m "docs: platform contract + design status for Flight Recorder P1"
git push
```

- [ ] **Step 4: Update PR #1941** title/body to reflect implementation:

```bash
gh pr edit 1941 --title "feat(diagnostics): Flight Recorder P1 — durable error log + thread debug bundle" \
  --body "$(cat <<'EOF'
## Summary
Implements Flight Recorder P1 + the debug bundle from the in-repo design doc (`docs/error-observability-design-2026-07-23.md`, committed in this PR's first commit):

- `brainstrike_diagnostic_events` (migration 072, both runners): durable warn+ events from the visible renderers, desktop main, and hidden hosts (pushed over the new `logging:durable-record` channel); write-time fingerprint, per-launch session id, bounded 30d/20k retention, factory-reset wired (desktop clearAll + web reset).
- `DiagnosticEventWriter`: batched, never on the stream path, loud loss (`diagnostics_events_dropped`), honest self-disable after repeated flush failures.
- `ErrorBoundary` now logs caught render errors through the central logger (durable via the sink).
- **Copy debug bundle** button on failed assistant messages: bounded (200 KB, visible elision log), redacted, versioned Markdown across failure summary / run config / timeline / correlated diagnostics / transcript / usage / environment / prior-failures-by-fingerprint.

## Out of scope (later phases per the design)
Log Viewer persistent source + status chip (P2), provider header forensics `run_errors` (P3), desktop NDJSON file sink + `queryDiagnostics` tool (P5), Save-bundle-to-file.

## Testing
Migration (both runners), repository (real PGlite), writer semantics, sink bridge, durable-record push, error-boundary logging, golden-bundle snapshot + bounds + redaction, UI button states. `pnpm build && pnpm lint && pnpm type-check && pnpm test` green in one run.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review (performed at plan-writing time)

- **Spec coverage:** design §4.2 capture (Tasks 5–7), §4.2 store (Task 2), §4.3 writer (Task 4), §4.4 correlation (Tasks 1/5), §5 bundle (Tasks 8–9), §12 invariants (retention Task 3, factory reset Task 5, loud loss Task 4, no stream-path awaits Task 4/5, redaction Tasks 1/8). Deliberately deferred per locked scope: §6 run_errors, §7 NDJSON, §8 tool, §9 viewer/chip.
- **Known verify-first points (flagged inline):** `redactSensitiveLogValue` export, `@brainstrike/db` root re-export path, `mastra_messages.createdAt` casing, the logging-ipc test harness shape, and the two architecture-guard tests. Each task names the exact grep to resolve them.
- **Type consistency:** `DiagnosticEvent` field list identical across Tasks 1/3/4/5/8; `DebugBundleBinding.buildBundle({ runId })` is the corrected final signature (Task 9 notes the correction explicitly).
