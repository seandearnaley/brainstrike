/** Temporary, opt-in timing only. Never serialize storage values, keys or errors. */
export function isPersistenceProofEnabled(): boolean {
  return (
    (globalThis as typeof globalThis & { brainstrikeWorkspacePhaseProof?: boolean })
      .brainstrikeWorkspacePhaseProof === true ||
    (typeof process !== 'undefined' &&
      process.env?.['BRAINSTRIKE_E2E_WORKSPACE_PHASE_TRACE'] === '1')
  );
}

const PERSISTENCE_PHASES = [
  'adapter-ack',
  'adapter-admitted',
  'adapter-queue',
  'adapter-start',
  'request-response',
  'save-caller',
  'save-caller-rejected',
  'save-rejected',
  'worker-post',
  'worker-posted',
  'worker-storage-request-received',
  'worker-timeout',
  'wrapper-save-ack',
  'wrapper-save-rejected',
  'wrapper-save-start',
  'storage-mutation-ack',
  'storage-mutation-admitted',
  'storage-mutation-queued',
  'storage-mutation-rejected',
  'storage-ipc-ack-ready',
  'storage-ipc-read-previous',
  'storage-ipc-received',
  'storage-ipc-rejected',
  'storage-ipc-written',
  'unhandled-rejection',
  'rejection-handled',
] as const;
type PersistencePhase = (typeof PERSISTENCE_PHASES)[number];
const persistencePhases = new Set<string>(PERSISTENCE_PHASES);
const PERSISTENCE_LAYERS = [
  'worker-storage',
  'storage-wrapper',
  'electron-storage',
  'storage-ipc',
  'renderer-error-hooks',
] as const;
type PersistenceLayer = (typeof PERSISTENCE_LAYERS)[number];
const persistenceLayers = new Set<string>(PERSISTENCE_LAYERS);

interface PersistenceProofFields {
  readonly admitted?: boolean | undefined;
  readonly callerCount?: number | undefined;
  readonly durationMs?: number | undefined;
  readonly layer: PersistenceLayer;
  readonly object?: object | undefined;
  readonly operation?: 'save' | 'load' | 'remove' | undefined;
  readonly operationId?: number | undefined;
  readonly pendingCount?: number | undefined;
  readonly promise?: object | undefined;
  readonly queued?: boolean | undefined;
  readonly reason?: unknown | undefined;
  readonly requestId?: string | undefined;
  readonly retired?: boolean | undefined;
}
const MAX_EVENTS = 512;
let sequence = 0;
let objectIds: WeakMap<object, number> | undefined;
let nextObjectId = 0;
function objectId(value: unknown): number | undefined {
  if (!(value !== null && (typeof value === 'object' || typeof value === 'function'))) {
    return;
  }
  objectIds ??= new WeakMap();
  const existing = objectIds.get(value);
  if (existing !== undefined) {
    return existing;
  }
  const id = ++nextObjectId;
  objectIds.set(value, id);
  return id;
}

/** No then/catch/listener is attached to the observed Promise. */
export function proofPersistence(
  phase: PersistencePhase,
  fields: PersistenceProofFields
): number | undefined {
  if (!isPersistenceProofEnabled()) {
    return;
  }
  if (
    !(persistencePhases.has(phase) && persistenceLayers.has(fields.layer)) ||
    sequence > MAX_EVENTS
  ) {
    return;
  }
  if (sequence++ === MAX_EVENTS) {
    // biome-ignore lint/suspicious/noConsole: Temporary bounded proof output uses the captured worker/renderer console transport.
    console.warn(
      '[persistence-proof] ' +
        JSON.stringify({
          limit: MAX_EVENTS,
          phase: 'truncated',
          timeOrigin: performance.timeOrigin,
        })
    );
    return;
  }
  const eventId = sequence;
  // biome-ignore lint/suspicious/noConsole: Temporary bounded proof output uses the captured worker/renderer console transport.
  console.warn(
    '[persistence-proof] ' +
      JSON.stringify({
        admitted: fields.admitted,
        at: Date.now(),
        callerCount: fields.callerCount,
        durationMs: fields.durationMs,
        eventId,
        layer: fields.layer,
        monotonicMs: performance.now(),
        objectId: objectId(fields.object),
        operation: fields.operation,
        operationId: fields.operationId,
        pendingCount: fields.pendingCount,
        phase,
        processPid: typeof process === 'undefined' ? undefined : process.pid,
        promiseId: objectId(fields.promise),
        queued: fields.queued,
        reasonId: objectId(fields.reason),
        requestId:
          fields.requestId !== undefined && /^\d+$/u.test(fields.requestId)
            ? fields.requestId
            : undefined,
        retired: fields.retired,
        timeOrigin: performance.timeOrigin,
      })
  );
  return eventId;
}
