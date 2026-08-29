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

export type McpLabTransportKind = 'http-in-process' | 'http-loopback' | 'stdio';

export interface McpLabFaultPlan {
  assertCompatibleWithTransport(transport: McpLabTransportKind): void;
  assertFullyConsumed(): void;
  consume(consumption: McpLabFaultConsumption): McpLabFault;
  consumeIfConfigured(consumption: McpLabFaultConsumption): McpLabFault | undefined;
  hasRemainingPhase(phase: McpLabProtocolPhase): boolean;
  observations(): readonly McpLabFaultObservation[];
  untriggeredIds(): readonly string[];
}

const CREATED_MCP_LAB_FAULT_PLANS = new WeakSet<object>();
const MCP_LAB_CORRELATION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/u;

export function isMcpLabFaultPlan(value: unknown): value is McpLabFaultPlan {
  return typeof value === 'object' && value !== null && CREATED_MCP_LAB_FAULT_PLANS.has(value);
}

export function isMcpLabCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && MCP_LAB_CORRELATION_ID_PATTERN.test(value);
}

function assertMcpLabCorrelationId(value: unknown): asserts value is string {
  if (!isMcpLabCorrelationId(value)) {
    throw new Error('Invalid MCP lab correlation id');
  }
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
      throw new Error(
        `Invalid MCP lab fault "${declaration.id}": unknown fault kind "${String(kind)}"`
      );
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

function faultSupportsTransport(
  declaration: McpLabFaultDeclaration,
  transport: McpLabTransportKind
): boolean {
  if (declaration.match.phase === 'shutdown') {
    return true;
  }
  if (transport !== 'stdio') {
    if (declaration.match.phase === 'child-process') {
      return false;
    }
    return !(transport === 'http-in-process' && declaration.match.method === 'node/dispatch');
  }
  if (declaration.match.phase === 'child-process') {
    return true;
  }
  if (declaration.match.phase === 'authorization' || declaration.match.phase === 'transport') {
    return false;
  }
  if (
    declaration.fault.kind === 'drop_response' &&
    declaration.match.method.startsWith('notifications/')
  ) {
    return false;
  }
  return declaration.fault.kind === 'delay' || declaration.fault.kind === 'drop_response';
}

function freezeDeclaration(declaration: McpLabFaultDeclaration): McpLabFaultDeclaration {
  return Object.freeze({
    fault: Object.freeze({ ...declaration.fault }) as McpLabFault,
    id: declaration.id,
    match: Object.freeze({ ...declaration.match }),
  });
}

function assertDeclarationShape(declaration: McpLabFaultDeclaration): void {
  const untypedDeclaration: unknown = declaration;
  if (!isRecord(untypedDeclaration)) {
    throw new Error('Invalid MCP lab fault declaration: expected an object');
  }
  const untypedId = untypedDeclaration['id'];
  if (typeof untypedId !== 'string' || untypedId.trim().length === 0) {
    throw new Error('Invalid MCP lab fault id: expected a non-empty string');
  }
  if (untypedId.length > 128 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(untypedId)) {
    throw new Error('Invalid MCP lab fault id: expected a lowercase identifier');
  }
  if (!hasOnlyKeys(untypedDeclaration, ['fault', 'id', 'match'])) {
    throw new Error(
      `Invalid MCP lab fault "${untypedId}": declaration must contain only "fault", "id", and "match"`
    );
  }
  const untypedMatch = untypedDeclaration['match'];
  if (!(isRecord(untypedMatch) && hasOnlyKeys(untypedMatch, ['phase', 'method', 'occurrence']))) {
    throw new Error(
      `Invalid MCP lab fault "${untypedId}": match must contain only "phase", "method", and "occurrence"`
    );
  }
}

function assertMatchProtocol(declaration: McpLabFaultDeclaration): void {
  if (!Number.isSafeInteger(declaration.match.occurrence) || declaration.match.occurrence < 1) {
    throw new Error(
      `Invalid MCP lab fault "${declaration.id}": occurrence must be a positive safe integer`
    );
  }
  const untypedPhase: unknown = declaration.match.phase;
  if (typeof untypedPhase !== 'string' || !Object.hasOwn(PROTOCOL_METHODS_BY_PHASE, untypedPhase)) {
    throw new Error(
      `Invalid MCP lab fault "${declaration.id}": unknown phase "${String(untypedPhase)}"`
    );
  }
  const methods = PROTOCOL_METHODS_BY_PHASE[untypedPhase as McpLabProtocolPhase];
  if (!(methods as readonly string[]).includes(declaration.match.method)) {
    throw new Error(
      `Invalid MCP lab fault "${declaration.id}": method "${declaration.match.method}" does not belong to phase "${declaration.match.phase}"`
    );
  }
  if (untypedPhase === 'child-process' && declaration.match.occurrence !== 1) {
    throw new Error(
      `Invalid MCP lab fault "${declaration.id}": child-process coordinates require occurrence 1`
    );
  }
  assertFaultCoordinate(declaration);
}

function registerUniqueDeclaration(
  declaration: McpLabFaultDeclaration,
  declaredIds: Set<string>,
  declaredMatches: Map<string, string>
): void {
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

function assertReachableShutdownDeclarations(
  declarations: readonly McpLabFaultDeclaration[]
): void {
  const shutdownDeclarations = declarations
    .filter((declaration) => declaration.match.phase === 'shutdown')
    .toSorted((left, right) => left.match.occurrence - right.match.occurrence);
  let expectedOccurrence = 1;
  let previousAttemptFailed = true;
  for (const declaration of shutdownDeclarations) {
    if (declaration.match.occurrence !== expectedOccurrence || !previousAttemptFailed) {
      throw new Error(
        `Invalid MCP lab fault "${declaration.id}": shutdown occurrence ${declaration.match.occurrence} is unreachable`
      );
    }
    previousAttemptFailed = declaration.fault.kind === 'cleanup_error';
    expectedOccurrence += 1;
  }
}

function validateFaultDeclarations(declarations: readonly McpLabFaultDeclaration[]): void {
  const declaredIds = new Set<string>();
  const declaredMatches = new Map<string, string>();
  for (const declaration of declarations) {
    assertDeclarationShape(declaration);
    assertFaultPayload(declaration);
    assertMatchProtocol(declaration);
    registerUniqueDeclaration(declaration, declaredIds, declaredMatches);
  }
  assertReachableShutdownDeclarations(declarations);
}

export function createMcpLabFaultPlan(
  declarations: readonly McpLabFaultDeclaration[]
): McpLabFaultPlan {
  validateFaultDeclarations(declarations);

  const immutableDeclarations = declarations.map(freezeDeclaration);
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
    assertCompatibleWithTransport(transport: McpLabTransportKind) {
      const incompatible = immutableDeclarations.find(
        (declaration) => !faultSupportsTransport(declaration, transport)
      );
      if (!incompatible) {
        return;
      }
      throw new Error(
        `MCP lab fault "${incompatible.id}" of kind "${incompatible.fault.kind}" at ${incompatible.match.phase}/${incompatible.match.method} is incompatible with ${transport} transport`
      );
    },
    assertFullyConsumed() {
      if (remaining.size === 0) {
        return;
      }
      throw new Error(`Untriggered MCP lab faults: ${untriggeredIds().join(', ')}`);
    },
    consume(consumption: McpLabFaultConsumption) {
      assertMcpLabCorrelationId(consumption.correlationId);
      const key = matchKey(consumption);
      const declaration = remaining.get(key);
      if (!declaration) {
        const exhausted = exhaustedFault(key);
        if (exhausted) {
          throw new Error(
            `MCP lab fault "${exhausted.id}" is exhausted for ${consumption.phase}/${consumption.method} occurrence ${consumption.occurrence}`
          );
        }
        throw new Error(
          `No MCP lab fault matches ${consumption.phase}/${consumption.method} occurrence ${consumption.occurrence}`
        );
      }
      return consumeDeclaration(consumption, declaration);
    },
    consumeIfConfigured(consumption: McpLabFaultConsumption) {
      assertMcpLabCorrelationId(consumption.correlationId);
      const key = matchKey(consumption);
      const declaration = remaining.get(key);
      if (declaration) {
        return consumeDeclaration(consumption, declaration);
      }
      const exhausted = exhaustedFault(key);
      if (exhausted) {
        throw new Error(
          `MCP lab fault "${exhausted.id}" is exhausted for ${consumption.phase}/${consumption.method} occurrence ${consumption.occurrence}`
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
