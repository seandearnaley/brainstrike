import { redactSensitiveLogValue } from '@brainstrike/logging';
import { scrubLikelySecretValues } from '@brainstrike/utils/diagnostics';
import type { ThreadDebugHostProbe } from './thread-debug-host-probe';

const REPEATED_VALUE_MARKER = '[REPEATED OR CIRCULAR]';
/** The desktop main-log IPC refuses a wider window. */
const HOST_WINDOW_MAX_MS = 24 * 60 * 60 * 1000;
/** The newest retained diagnostic events a pack carries (BST-2347). */
const DIAGNOSTIC_EVENTS_LIMIT = 50;
const NO_BRIDGE_REASON =
  'no desktop diagnostics bridge exposing listCrashDumps, queryEvents, readMainLogWindow and readProcessCounters (web build or older preload)';
/** One piece of desktop host evidence, fetched when the pack is built, never persisted. */
export type ThreadDebugHostItem =
  | { readonly status: 'included'; readonly value: Readonly<Record<string, unknown>> }
  | { readonly reason: string; readonly status: 'unavailable' };

export interface ThreadDebugHostEvidence {
  /** The profile's local minidumps, from any launch since the last factory reset. */
  readonly crashDumps: ThreadDebugHostItem;
  /** The status bar's records: whatever any process logged at warn or above, not only this run. */
  readonly diagnosticEvents: ThreadDebugHostItem;
  readonly hostLog: ThreadDebugHostItem;
  readonly processCounters: ThreadDebugHostItem;
  readonly window: { readonly since: string; readonly until: string } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseInstant(value: unknown, subject: string): number {
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) {
    throw new Error(`Thread debug pack: ${subject} is not a timestamp.`);
  }
  return ms;
}

/** Earliest run start, clamped to 24 hours before capture, through capture. */
export function boundedHostWindow(
  capturedAt: string,
  earliestRunStartMs: number | null
): ThreadDebugHostEvidence['window'] {
  const until = parseInstant(capturedAt, 'capturedAt');
  if (earliestRunStartMs === null) {
    return null;
  }
  return {
    since: new Date(Math.max(earliestRunStartMs, until - HOST_WINDOW_MAX_MS)).toISOString(),
    until: new Date(until).toISOString(),
  };
}

async function readHostItem(
  read: () => Promise<unknown>,
  arrayKey: 'dumps' | 'events' | 'lines' | 'samples',
  label: string
): Promise<ThreadDebugHostItem> {
  let value: unknown;
  try {
    value = await read();
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : String(error),
      status: 'unavailable',
    };
  }
  if (!(isRecord(value) && Array.isArray(value[arrayKey]))) {
    return { reason: `malformed ${label} result (no ${arrayKey} array)`, status: 'unavailable' };
  }
  return { status: 'included', value };
}

/** Reads the desktop host evidence for a run window; every gap carries its reason. */
export async function collectHostEvidence(
  probe: ThreadDebugHostProbe | null,
  resolveWindow: () => ThreadDebugHostEvidence['window']
): Promise<ThreadDebugHostEvidence> {
  if (probe === null) {
    const missing = { reason: NO_BRIDGE_REASON, status: 'unavailable' } as const;
    return {
      crashDumps: missing,
      diagnosticEvents: missing,
      hostLog: missing,
      processCounters: missing,
      window: null,
    };
  }
  const window = resolveWindow();
  const hostLog: ThreadDebugHostItem =
    window === null
      ? { reason: 'no run start in the snapshot to bound the log window', status: 'unavailable' }
      : await readHostItem(() => probe.readMainLogWindow(window), 'lines', 'main log window');
  const processCounters = await readHostItem(
    () => probe.readProcessCounters(),
    'samples',
    'process counter'
  );
  // Not bounded by the run window: an error the status bar counts may come
  // from startup or another thread, and the pack is where it gets explained.
  const diagnosticEvents = await readHostItem(
    async () => ({ events: await probe.queryEvents({ limit: DIAGNOSTIC_EVENTS_LIMIT }) }),
    'events',
    'diagnostic events'
  );
  const crashDumps = await readHostItem(() => probe.listCrashDumps(), 'dumps', 'crash dump');
  return { crashDumps, diagnosticEvents, hostLog, processCounters, window };
}

/** Host evidence as a pack section: the value, or null with its reason in the manifest. */
export function hostEvidenceValue(
  item: ThreadDebugHostItem
): Readonly<Record<string, unknown>> | null {
  return item.status === 'included' ? item.value : null;
}

function describeHostItem(item: ThreadDebugHostItem): string {
  return item.status === 'included' ? 'included' : `unavailable: ${item.reason}`;
}

/** An export's sections and host manifest after both redaction passes. */
export interface RedactedDebugPack {
  readonly hostManifest: Readonly<Record<string, unknown>>;
  readonly redaction: {
    readonly keyNames: true;
    readonly valueCount: number;
    readonly valueKinds: readonly string[];
  };
  readonly sections: unknown;
  readonly structuralElisions: { readonly depth: number; readonly repeated: number };
}

/**
 * Both redaction passes every exported pack takes: sensitive key names (with
 * depth and repeated-value bounds), then recognized secret value shapes in
 * every string. Host evidence sits INSIDE sections, so both passes cover it;
 * an unavailable reason takes the same value scrub.
 */
export function redactDebugPack(
  sections: Record<string, unknown>,
  host: ThreadDebugHostEvidence
): RedactedDebugPack {
  let redactedValues = 0;
  let depthElisions = 0;
  let repeatedElisions = 0;
  const redactedKinds = new Set<string>();
  // Scan string values before serialization so multiline PEMs are still literal
  // multiline text, and replacement cannot invalidate the exported JSON.
  const scrub = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const result = scrubLikelySecretValues(value);
      redactedValues += result.redactedCount;
      for (const kind of result.kinds) {
        redactedKinds.add(kind);
      }
      return result.text;
    }
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        value[index] = scrub(value[index]);
      }
      return value;
    }
    if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        (value as Record<string, unknown>)[key] = scrub(entry);
      }
      return value;
    }
    return value;
  };
  const redactedSections = scrub(
    redactSensitiveLogValue(sections, [], new WeakMap(), {
      maxDepth: 64,
      onDepthTruncated: () => {
        depthElisions += 1;
      },
      onRepeatedValue: () => {
        repeatedElisions += 1;
      },
      repeatedValue: REPEATED_VALUE_MARKER,
    })
  );
  // An unavailable reason is a raw IPC error message outside sections: it takes
  // the same value scrub and count. Paths stay (documented export content).
  const hostManifest = {
    crashDumps: scrub(describeHostItem(host.crashDumps)),
    diagnosticEvents: scrub(describeHostItem(host.diagnosticEvents)),
    hostLog: scrub(describeHostItem(host.hostLog)),
    processCounters: scrub(describeHostItem(host.processCounters)),
    window: host.window,
  };
  return {
    hostManifest,
    redaction: {
      keyNames: true,
      valueCount: redactedValues,
      valueKinds: [...redactedKinds].sort(),
    },
    sections: redactedSections,
    structuralElisions: { depth: depthElisions, repeated: repeatedElisions },
  };
}
