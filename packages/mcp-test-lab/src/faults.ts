const PROTOCOL_METHODS_BY_PHASE = {
  authorization: [
    'oauth/protected-resource',
    'oauth/authorization-server',
    'oauth/register',
    'oauth/authorize',
    'oauth/callback',
    'oauth/token',
    'oauth/revoke',
  ],
  'child-process': ['child/spawn', 'child/stderr', 'child/exit'],
  initialization: ['initialize', 'notifications/initialized', 'ping'],
  operation: [
    'completion/complete',
    'elicitation/create',
    'logging/setLevel',
    'prompts/get',
    'prompts/list',
    'resources/list',
    'resources/read',
    'resources/subscribe',
    'resources/templates/list',
    'resources/unsubscribe',
    'roots/list',
    'sampling/createMessage',
    'tasks/cancel',
    'tasks/get',
    'tasks/list',
    'tasks/result',
    'tools/call',
    'tools/list',
  ],
  shutdown: ['transport/close'],
  subscription: [
    'subscriptions/listen',
    'notifications/cancelled',
    'notifications/message',
    'notifications/progress',
    'notifications/prompts/list_changed',
    'notifications/resources/list_changed',
    'notifications/resources/updated',
    'notifications/tools/list_changed',
  ],
  transport: ['http/request', 'http/response', 'node/dispatch'],
} as const;

export type McpLabProtocolPhase = keyof typeof PROTOCOL_METHODS_BY_PHASE;
export type McpLabProtocolMethod = (typeof PROTOCOL_METHODS_BY_PHASE)[McpLabProtocolPhase][number];

export function protocolPhaseForMethod(method: string): McpLabProtocolPhase | undefined {
  if ((PROTOCOL_METHODS_BY_PHASE.authorization as readonly string[]).includes(method)) {
    return 'authorization';
  }
  if ((PROTOCOL_METHODS_BY_PHASE['child-process'] as readonly string[]).includes(method)) {
    return 'child-process';
  }
  if ((PROTOCOL_METHODS_BY_PHASE.initialization as readonly string[]).includes(method)) {
    return 'initialization';
  }
  if ((PROTOCOL_METHODS_BY_PHASE.operation as readonly string[]).includes(method)) {
    return 'operation';
  }
  if ((PROTOCOL_METHODS_BY_PHASE.shutdown as readonly string[]).includes(method)) {
    return 'shutdown';
  }
  if ((PROTOCOL_METHODS_BY_PHASE.subscription as readonly string[]).includes(method)) {
    return 'subscription';
  }
  if ((PROTOCOL_METHODS_BY_PHASE.transport as readonly string[]).includes(method)) {
    return 'transport';
  }
  return;
}

export interface McpLabDelayFault {
  readonly delayMs: number;
  readonly kind: 'delay';
}

export interface McpLabHttpStatusFault {
  readonly kind: 'http_status';
  readonly status: number;
}

export interface McpLabMalformedJsonFault {
  readonly kind: 'malformed_json';
  readonly payload: string;
}

export interface McpLabDroppedResponseFault {
  readonly kind: 'drop_response';
}

export interface McpLabCleanupErrorFault {
  readonly kind: 'cleanup_error';
}

export interface McpLabChildStderrFault {
  readonly kind: 'child_stderr';
  readonly text: string;
}

const MCP_LAB_CHILD_SIGNALS = ['SIGABRT', 'SIGKILL', 'SIGTERM'] as const;

const MCP_LAB_CHILD_SIGNAL_SET = new Set<string>(MCP_LAB_CHILD_SIGNALS);

export type McpLabChildSignal = (typeof MCP_LAB_CHILD_SIGNALS)[number];

export type McpLabChildExitFault =
  | {
      readonly code: number;
      readonly kind: 'child_exit';
      readonly signal: null;
    }
  | {
      readonly code: null;
      readonly kind: 'child_exit';
      readonly signal: McpLabChildSignal;
    };

export type McpLabFault =
  | McpLabChildExitFault
  | McpLabChildStderrFault
  | McpLabCleanupErrorFault
  | McpLabDelayFault
  | McpLabDroppedResponseFault
  | McpLabHttpStatusFault
  | McpLabMalformedJsonFault;

export interface McpLabFaultMatch {
  readonly method: McpLabProtocolMethod;
  readonly occurrence: number;
  readonly phase: McpLabProtocolPhase;
}

export interface McpLabFaultDeclaration {
  readonly fault: McpLabFault;
  readonly id: string;
  readonly match: McpLabFaultMatch;
}

export interface McpLabFaultConsumption extends McpLabFaultMatch {
  readonly correlationId: string;
}

export interface McpLabFaultObservation extends McpLabFaultConsumption {
  readonly faultId: string;
  readonly faultKind: McpLabFault['kind'];
}

export interface McpLabFaultPlan {
  assertFullyConsumed(): void;
  consume(consumption: McpLabFaultConsumption): McpLabFault;
  consumeIfConfigured(consumption: McpLabFaultConsumption): McpLabFault | undefined;
  hasRemainingPhase(phase: McpLabProtocolPhase): boolean;
  observations(): readonly McpLabFaultObservation[];
  untriggeredIds(): readonly string[];
}

const CREATED_MCP_LAB_FAULT_PLANS = new WeakSet<object>();
const MAX_MCP_LAB_FAULT_DECLARATIONS = 1024;
const MCP_LAB_CORRELATION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const MCP_LAB_FAULT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function isMcpLabFaultPlan(value: unknown): value is McpLabFaultPlan {
  return typeof value === 'object' && value !== null && CREATED_MCP_LAB_FAULT_PLANS.has(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function snapshotRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new Error('Invalid MCP lab fault declaration: expected an object');
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  try {
    for (const key of Object.keys(value)) {
      snapshot[key] = value[key];
    }
  } catch {
    throw new Error('Invalid MCP lab fault declaration: could not snapshot input');
  }
  return snapshot;
}

function snapshotDeclaration(value: unknown): McpLabFaultDeclaration {
  const declaration = snapshotRecord(value);
  const untypedFault = declaration['fault'];
  const untypedMatch = declaration['match'];
  const fault = isRecord(untypedFault) ? snapshotRecord(untypedFault) : untypedFault;
  const match = isRecord(untypedMatch) ? snapshotRecord(untypedMatch) : untypedMatch;
  return { fault, id: declaration['id'], match } as unknown as McpLabFaultDeclaration;
}

function snapshotConsumption(value: unknown): McpLabFaultConsumption {
  if (!isRecord(value)) {
    throw new Error('Invalid MCP lab fault consumption: expected an object');
  }
  let snapshot: Readonly<Record<string, unknown>>;
  try {
    snapshot = Object.freeze({
      correlationId: value['correlationId'],
      method: value['method'],
      occurrence: value['occurrence'],
      phase: value['phase'],
    });
  } catch {
    throw new Error('Invalid MCP lab fault consumption: could not snapshot input');
  }
  if (
    typeof snapshot['correlationId'] !== 'string' ||
    !MCP_LAB_CORRELATION_ID_PATTERN.test(snapshot['correlationId'])
  ) {
    throw new Error('Invalid MCP lab correlation id');
  }
  if (!Number.isSafeInteger(snapshot['occurrence']) || Number(snapshot['occurrence']) < 1) {
    throw new Error('Invalid MCP lab fault consumption occurrence');
  }
  const phase = snapshot['phase'];
  if (typeof phase !== 'string' || !Object.hasOwn(PROTOCOL_METHODS_BY_PHASE, phase)) {
    throw new Error('Invalid MCP lab fault consumption phase');
  }
  if (
    !(PROTOCOL_METHODS_BY_PHASE[phase as McpLabProtocolPhase] as readonly unknown[]).includes(
      snapshot['method']
    )
  ) {
    throw new Error('Invalid MCP lab fault consumption method');
  }
  return snapshot as unknown as McpLabFaultConsumption;
}

function matchKey(match: McpLabFaultMatch): string {
  return `${match.phase}\u0000${match.method}\u0000${match.occurrence}`;
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[]
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

type UntypedFault = Readonly<Record<string, unknown>>;

function assertOnlyFaultKeys(
  id: string,
  fault: UntypedFault,
  expectedKeys: readonly string[],
  message: string
): void {
  if (!hasOnlyKeys(fault, expectedKeys)) {
    throw new Error(`Invalid MCP lab fault "${id}": ${message}`);
  }
}

function assertChildExitFault(id: string, fault: UntypedFault): void {
  assertOnlyFaultKeys(
    id,
    fault,
    ['kind', 'code', 'signal'],
    'child exit must contain only "kind", "code", and "signal"'
  );
  const exitedWithCode =
    typeof fault['code'] === 'number' &&
    Number.isInteger(fault['code']) &&
    fault['code'] >= 0 &&
    fault['code'] <= 255 &&
    fault['signal'] === null;
  const exitedWithSignal =
    fault['code'] === null &&
    typeof fault['signal'] === 'string' &&
    MCP_LAB_CHILD_SIGNAL_SET.has(fault['signal']);
  if (!(exitedWithCode || exitedWithSignal)) {
    throw new Error(
      `Invalid MCP lab fault "${id}": child exit must provide a code from 0 to 255 or a supported terminating signal`
    );
  }
}

function assertChildStderrFault(id: string, fault: UntypedFault): void {
  const text = fault['text'];
  if (typeof text !== 'string') {
    throw new Error(`Invalid MCP lab fault "${id}": child stderr text must be a string`);
  }
  if (text.length === 0) {
    throw new Error(`Invalid MCP lab fault "${id}": child stderr text must be non-empty`);
  }
  assertOnlyFaultKeys(
    id,
    fault,
    ['kind', 'text'],
    'child stderr must contain only "kind" and "text"'
  );
}

function assertMalformedJsonFault(id: string, fault: UntypedFault): void {
  const payload = fault['payload'];
  if (typeof payload !== 'string') {
    throw new Error(`Invalid MCP lab fault "${id}": malformed JSON payload must be a string`);
  }
  if (payload.trim().length === 0) {
    throw new Error(`Invalid MCP lab fault "${id}": malformed JSON payload must be non-empty`);
  }
  assertOnlyFaultKeys(
    id,
    fault,
    ['kind', 'payload'],
    'malformed JSON must contain only "kind" and "payload"'
  );
  try {
    JSON.parse(payload);
  } catch {
    return;
  }
  throw new Error(
    `Invalid MCP lab fault "${id}": malformed JSON payload must be syntactically invalid JSON`
  );
}

function assertDelayFault(id: string, fault: UntypedFault): void {
  const delayMs = fault['delayMs'];
  if (
    typeof delayMs !== 'number' ||
    !Number.isInteger(delayMs) ||
    delayMs < 1 ||
    delayMs > 60_000
  ) {
    throw new Error(`Invalid MCP lab fault "${id}": delay must be an integer from 1 to 60000 ms`);
  }
  assertOnlyFaultKeys(
    id,
    fault,
    ['kind', 'delayMs'],
    'delay must contain only "kind" and "delayMs"'
  );
}

function assertHttpStatusFault(id: string, fault: UntypedFault): void {
  const status = fault['status'];
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 599) {
    throw new Error(
      `Invalid MCP lab fault "${id}": HTTP status must be an integer from 400 to 599`
    );
  }
  assertOnlyFaultKeys(
    id,
    fault,
    ['kind', 'status'],
    'HTTP status must contain only "kind" and "status"'
  );
}

function assertFaultPayload(declaration: McpLabFaultDeclaration): void {
  const untypedFault: unknown = declaration.fault;
  if (typeof untypedFault !== 'object' || untypedFault === null || Array.isArray(untypedFault)) {
    throw new Error(`Invalid MCP lab fault "${declaration.id}": payload must be an object`);
  }
  const fault = untypedFault as Readonly<Record<string, unknown>>;
  const kind = fault['kind'];
  switch (kind) {
    case 'child_exit':
      assertChildExitFault(declaration.id, fault);
      return;
    case 'child_stderr':
      assertChildStderrFault(declaration.id, fault);
      return;
    case 'cleanup_error':
      assertOnlyFaultKeys(
        declaration.id,
        fault,
        ['kind'],
        'cleanup error must contain only "kind"'
      );
      return;
    case 'drop_response':
      assertOnlyFaultKeys(
        declaration.id,
        fault,
        ['kind'],
        'drop response must contain only "kind"'
      );
      return;
    case 'malformed_json':
      assertMalformedJsonFault(declaration.id, fault);
      return;
    case 'delay':
      assertDelayFault(declaration.id, fault);
      return;
    case 'http_status':
      assertHttpStatusFault(declaration.id, fault);
      return;
    default:
      throw new Error(`Invalid MCP lab fault "${declaration.id}": unknown fault kind`);
  }
}

function incompatibleCoordinate(declaration: McpLabFaultDeclaration): never {
  throw new Error(
    `Invalid MCP lab fault "${declaration.id}": kind "${declaration.fault.kind}" is incompatible with coordinate ${declaration.match.phase}/${declaration.match.method}`
  );
}

function assertFaultCoordinate(declaration: McpLabFaultDeclaration): void {
  const { fault, match } = declaration;
  if (fault.kind === 'child_exit') {
    if (match.phase !== 'child-process' || match.method !== 'child/exit') {
      incompatibleCoordinate(declaration);
    }
    return;
  }
  if (fault.kind === 'child_stderr') {
    if (match.phase !== 'child-process' || match.method !== 'child/stderr') {
      incompatibleCoordinate(declaration);
    }
    return;
  }
  if (fault.kind === 'cleanup_error') {
    if (match.phase !== 'shutdown' || match.method !== 'transport/close') {
      incompatibleCoordinate(declaration);
    }
    return;
  }
  if (match.phase === 'child-process') {
    if (
      match.method !== 'child/spawn' ||
      (fault.kind !== 'delay' && fault.kind !== 'malformed_json')
    ) {
      incompatibleCoordinate(declaration);
    }
    return;
  }
  if (match.phase === 'shutdown' && fault.kind !== 'delay') {
    incompatibleCoordinate(declaration);
  }
}

function freezeDeclaration(declaration: McpLabFaultDeclaration): McpLabFaultDeclaration {
  return Object.freeze({
    fault: Object.freeze({ ...declaration.fault }) as McpLabFault,
    id: declaration.id,
    match: Object.freeze({ ...declaration.match }),
  });
}

function snapshotDeclarations(value: unknown): readonly McpLabFaultDeclaration[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid MCP lab fault declarations: expected an array');
  }
  let declarationCount: number;
  try {
    declarationCount = value.length;
  } catch {
    throw new Error('Invalid MCP lab fault declarations: could not read array length');
  }
  if (
    !Number.isSafeInteger(declarationCount) ||
    declarationCount < 0 ||
    declarationCount > MAX_MCP_LAB_FAULT_DECLARATIONS
  ) {
    throw new Error(
      `Invalid MCP lab fault declarations: expected at most ${MAX_MCP_LAB_FAULT_DECLARATIONS} entries`
    );
  }
  const snapshots: McpLabFaultDeclaration[] = [];
  for (let index = 0; index < declarationCount; index += 1) {
    let declaration: unknown;
    try {
      declaration = value[index];
    } catch {
      throw new Error('Invalid MCP lab fault declarations: could not snapshot entry');
    }
    snapshots.push(snapshotDeclaration(declaration));
  }
  return snapshots;
}

export function createMcpLabFaultPlan(
  declarations: readonly McpLabFaultDeclaration[]
): McpLabFaultPlan {
  const snapshots = snapshotDeclarations(declarations);
  const declaredIds = new Set<string>();
  const declaredMatches = new Map<string, string>();
  for (const declaration of snapshots) {
    if (
      typeof declaration.id !== 'string' ||
      declaration.id.length > 128 ||
      !MCP_LAB_FAULT_ID_PATTERN.test(declaration.id)
    ) {
      throw new Error('Invalid MCP lab fault id: expected a lowercase identifier');
    }
    assertFaultPayload(declaration);
    if (!Number.isSafeInteger(declaration.match.occurrence) || declaration.match.occurrence < 1) {
      throw new Error(
        `Invalid MCP lab fault "${declaration.id}": occurrence must be a positive safe integer`
      );
    }
    const phase: unknown = declaration.match.phase;
    if (typeof phase !== 'string' || !Object.hasOwn(PROTOCOL_METHODS_BY_PHASE, phase)) {
      throw new Error(`Invalid MCP lab fault "${declaration.id}": unknown phase`);
    }
    const methods = PROTOCOL_METHODS_BY_PHASE[phase as McpLabProtocolPhase];
    if (!(methods as readonly string[]).includes(declaration.match.method)) {
      throw new Error(
        `Invalid MCP lab fault "${declaration.id}": method "${declaration.match.method}" does not belong to phase "${declaration.match.phase}"`
      );
    }
    assertFaultCoordinate(declaration);
    if (declaredIds.has(declaration.id)) {
      throw new Error(`Duplicate MCP lab fault id: ${declaration.id}`);
    }
    declaredIds.add(declaration.id);

    const key = matchKey(declaration.match);
    const existingId = declaredMatches.get(key);
    if (existingId) {
      throw new Error(
        `Duplicate MCP lab fault match for ${declaration.match.phase}/${declaration.match.method} occurrence ${declaration.match.occurrence}: ${existingId}, ${declaration.id}`
      );
    }
    declaredMatches.set(key, declaration.id);
  }

  const immutableDeclarations = snapshots.map(freezeDeclaration);
  const remaining = new Map(
    immutableDeclarations.map((declaration) => [matchKey(declaration.match), declaration] as const)
  );
  const consumed = new Map<string, McpLabFaultDeclaration>();
  const observations: McpLabFaultObservation[] = [];

  function consumeDeclaration(
    consumption: McpLabFaultConsumption,
    declaration: McpLabFaultDeclaration
  ): McpLabFault {
    const key = matchKey(consumption);
    remaining.delete(key);
    consumed.set(key, declaration);
    observations.push(
      Object.freeze({
        correlationId: consumption.correlationId,
        faultId: declaration.id,
        faultKind: declaration.fault.kind,
        method: consumption.method,
        occurrence: consumption.occurrence,
        phase: consumption.phase,
      })
    );
    return declaration.fault;
  }

  function exhaustedFault(key: string): McpLabFaultDeclaration | undefined {
    return consumed.get(key);
  }

  function untriggeredIds(): readonly string[] {
    return Object.freeze([...remaining.values()].map((declaration) => declaration.id).sort());
  }

  const plan: McpLabFaultPlan = Object.freeze({
    assertFullyConsumed() {
      if (remaining.size === 0) {
        return;
      }
      throw new Error(`Untriggered MCP lab faults: ${untriggeredIds().join(', ')}`);
    },
    consume(consumption: McpLabFaultConsumption) {
      const snapshot = snapshotConsumption(consumption);
      const key = matchKey(snapshot);
      const declaration = remaining.get(key);
      if (!declaration) {
        const exhausted = exhaustedFault(key);
        if (exhausted) {
          throw new Error(
            `MCP lab fault "${exhausted.id}" is exhausted for ${snapshot.phase}/${snapshot.method} occurrence ${snapshot.occurrence}`
          );
        }
        throw new Error(
          `No MCP lab fault matches ${snapshot.phase}/${snapshot.method} occurrence ${snapshot.occurrence}`
        );
      }
      return consumeDeclaration(snapshot, declaration);
    },
    consumeIfConfigured(consumption: McpLabFaultConsumption) {
      const snapshot = snapshotConsumption(consumption);
      const key = matchKey(snapshot);
      const declaration = remaining.get(key);
      if (declaration) {
        return consumeDeclaration(snapshot, declaration);
      }
      const exhausted = exhaustedFault(key);
      if (exhausted) {
        throw new Error(
          `MCP lab fault "${exhausted.id}" is exhausted for ${snapshot.phase}/${snapshot.method} occurrence ${snapshot.occurrence}`
        );
      }
      return;
    },
    hasRemainingPhase(phase: McpLabProtocolPhase) {
      return [...remaining.values()].some((declaration) => declaration.match.phase === phase);
    },
    observations() {
      return Object.freeze(observations.slice());
    },
    untriggeredIds,
  });
  CREATED_MCP_LAB_FAULT_PLANS.add(plan);
  return plan;
}
