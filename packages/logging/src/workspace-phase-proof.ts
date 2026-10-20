/** Temporary BST-2269 proof instrumentation; remove after the causal run. */
type Operation =
  | 'registry.mutation'
  | 'registry.directory-read'
  | 'ipc.watch'
  | 'renderer.root-load'
  | 'renderer.restore-observer';
type Phase = 'admit' | 'start' | 'wait' | 'ready' | 'settle' | 'ack' | 'discard' | 'cleanup';
export interface WorkspacePhaseProofFields {
  readonly count?: number;
  readonly disposed?: boolean;
  readonly generation?: number;
  readonly mutationName?:
    | 'add-root'
    | 'restore-roots'
    | 'list-recents'
    | 'root-deletion'
    | 'clear-content'
    | 'remove-root'
    | 'restore-last-folder'
    | 'set-last-folder'
    | 'other';
  readonly ownerId?: number;
  readonly queuedAfter?: number;
  readonly rootId?: unknown;
  readonly stage?:
    | 'catalog-find'
    | 'catalog-register'
    | 'catalog-restore'
    | 'catalog-converge'
    | 'list';
  readonly status?: 'success' | 'failure' | 'cancelled' | 'skipped';
}
export interface WorkspacePhaseProof {
  readonly id: number;
  mark(phase: Phase, fields?: WorkspacePhaseProofFields): void;
}
const MAX_EVENTS = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const NOOP: WorkspacePhaseProof = { id: 0, mark: () => undefined };
let sequence = 0;
let emitted = 0;
let realmId: string | undefined;

function project(fields: WorkspacePhaseProofFields): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  if (fields.rootId !== undefined) {
    safe['rootId'] =
      typeof fields.rootId === 'string' && UUID.test(fields.rootId)
        ? fields.rootId
        : '[invalid-id]';
  }
  for (const key of ['queuedAfter', 'generation', 'count', 'ownerId'] as const) {
    const value = fields[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      safe[key] = Math.min(value, 2_147_483_647);
    }
  }
  if (typeof fields.disposed === 'boolean') {
    safe['disposed'] = fields.disposed;
  }
  if (
    fields.mutationName &&
    [
      'add-root',
      'restore-roots',
      'list-recents',
      'root-deletion',
      'clear-content',
      'remove-root',
      'restore-last-folder',
      'set-last-folder',
      'other',
    ].includes(fields.mutationName)
  ) {
    safe['mutationName'] = fields.mutationName;
  }
  if (
    fields.stage &&
    ['catalog-find', 'catalog-register', 'catalog-restore', 'catalog-converge', 'list'].includes(
      fields.stage
    )
  ) {
    safe['stage'] = fields.stage;
  }
  if (fields.status && ['success', 'failure', 'cancelled', 'skipped'].includes(fields.status)) {
    safe['status'] = fields.status;
  }
  return safe;
}

/** Uses existing log transports; no exporter, file, timer, retry, or persistence owner. */
export function beginWorkspacePhaseProof(
  logger: { warn(message: string, fields: Record<string, unknown>): void },
  operation: Operation,
  fields: WorkspacePhaseProofFields = {}
): WorkspacePhaseProof {
  const enabled =
    (typeof process !== 'undefined' &&
      process.env?.['BRAINSTRIKE_E2E_WORKSPACE_PHASE_TRACE'] === '1') ||
    (globalThis as { brainstrikeWorkspacePhaseProof?: boolean }).brainstrikeWorkspacePhaseProof ===
      true;
  if (
    !enabled ||
    emitted > MAX_EVENTS ||
    ![
      'registry.mutation',
      'registry.directory-read',
      'ipc.watch',
      'renderer.root-load',
      'renderer.restore-observer',
    ].includes(operation)
  ) {
    return NOOP;
  }
  realmId ??= globalThis.crypto.randomUUID();
  const id = ++sequence;
  const started = performance.now();
  const identity = { ...project(fields), operation, operationId: id, realmId };
  const mark: WorkspacePhaseProof['mark'] = (phase, extra = {}) => {
    if (
      emitted > MAX_EVENTS ||
      !['admit', 'start', 'wait', 'ready', 'settle', 'ack', 'discard', 'cleanup'].includes(phase)
    ) {
      return;
    }
    if (emitted++ === MAX_EVENTS) {
      logger.warn('[DEBUG-BST2269] workspace phase proof truncated', {
        limit: MAX_EVENTS,
        realmId,
      });
      return;
    }
    logger.warn('[DEBUG-BST2269] workspace phase proof', {
      ...identity,
      ...project(extra),
      elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
      phase,
    });
  };
  mark('admit');
  return { id, mark };
}
