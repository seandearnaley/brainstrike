import { createMcpLabFaultExecutionTracker } from './fault-execution.js';
import {
  isRegisteredMcpLabFaultPlan,
  MCP_LAB_CLAIMED_PLAN,
  type McpLabClaimedFaultPlan,
  registerMcpLabFaultPlanClaim,
} from './fault-plan-claim.js';
import type { McpLabFaultPlan } from './fault-plan-types.js';
import {
  isExecutableProtocolMethod,
  type McpLabOperationMethod,
  type McpLabProtocolEra,
  type McpLabProtocolMethod,
  type McpLabProtocolPhase,
  OPERATIONS_BY_FIXTURE,
  PROTOCOL_METHODS_BY_PHASE,
  protocolPhaseForMethod,
} from './fault-vocabulary.js';
import { getMcpLabScenario, type McpLabFixture, type McpLabScenario } from './scenario.js';

// The protocol vocabulary lives in `fault-vocabulary.ts`; re-exported here so
// every existing importer keeps its single `./faults.js` entry point.
export {
  isExecutableProtocolMethod,
  type McpLabOperationMethod,
  type McpLabProtocolEra,
  type McpLabProtocolMethod,
  type McpLabProtocolPhase,
  protocolPhaseForMethod,
};

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

const MCP_LAB_CHILD_SIGNALS = ['SIGKILL', 'SIGTERM'] as const;
const MAX_MCP_LAB_CHILD_STDERR_BYTES = 4096;

const MCP_LAB_CHILD_SIGNAL_SET = new Set<string>(MCP_LAB_CHILD_SIGNALS);
const NON_CLIENT_EXECUTABLE_METHODS = new Set<McpLabProtocolMethod>([
  'elicitation/create',
  'notifications/elicitation/complete',
  'notifications/message',
  'notifications/prompts/list_changed',
  'notifications/resources/list_changed',
  'notifications/resources/updated',
  'notifications/subscriptions/acknowledged',
  'notifications/tasks/status',
  'notifications/tools/list_changed',
  'roots/list',
  'sampling/createMessage',
]);
const MODERN_ONLY_METHODS = new Set<McpLabProtocolMethod>([
  'notifications/subscriptions/acknowledged',
  'server/discover',
  'subscriptions/listen',
]);
// Exact @modelcontextprotocol/core@2.0.0 codec-registry difference at cc4b416.
const LEGACY_ONLY_METHODS = new Set<McpLabProtocolMethod>([
  'initialize',
  'notifications/elicitation/complete',
  'notifications/initialized',
  'notifications/roots/list_changed',
  'notifications/tasks/status',
  'ping',
  'elicitation/create',
  'logging/setLevel',
  'resources/subscribe',
  'resources/unsubscribe',
  'roots/list',
  'sampling/createMessage',
  'tasks/cancel',
  'tasks/get',
  'tasks/list',
  'tasks/result',
]);
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

export type { McpLabFaultExecutionState } from './fault-execution.js';

export type McpLabTransportKind = 'http-in-process' | 'http-loopback' | 'stdio';
export type McpLabAuthentication = 'none' | 'oauth';
export type McpLabExecution = 'in-process' | 'loopback' | undefined;

export type { McpLabFaultPlan } from './fault-plan-types.js';

const MAX_MCP_LAB_FAULT_DECLARATIONS = 1024;
const MCP_LAB_CORRELATION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const MCP_LAB_FAULT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function isMcpLabFaultPlan(value: unknown): value is McpLabFaultPlan {
  return isRegisteredMcpLabFaultPlan(value);
}

export function isMcpLabCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && MCP_LAB_CORRELATION_ID_PATTERN.test(value);
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
  if (!Object.hasOwn(declaration, 'fault')) {
    throw new Error('Invalid MCP lab fault declaration: missing "fault" field');
  }
  if (!Object.hasOwn(declaration, 'match')) {
    throw new Error('Invalid MCP lab fault declaration: missing "match" field');
  }
  const untypedFault = declaration['fault'];
  const untypedMatch = declaration['match'];
  const fault = isRecord(untypedFault) ? snapshotRecord(untypedFault) : untypedFault;
  const match = isRecord(untypedMatch) ? snapshotRecord(untypedMatch) : untypedMatch;
  return { ...declaration, fault, match } as unknown as McpLabFaultDeclaration;
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
  if (Buffer.byteLength(text) > MAX_MCP_LAB_CHILD_STDERR_BYTES) {
    throw new Error(
      `Invalid MCP lab fault "${id}": child stderr text exceeds ${MAX_MCP_LAB_CHILD_STDERR_BYTES} bytes`
    );
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
    if (match.method !== 'child/spawn' || fault.kind !== 'delay') {
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
      `Invalid MCP lab fault declarations: expected an integer count from 0 to ${MAX_MCP_LAB_FAULT_DECLARATIONS}`
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

function assertDeclarationShape(declaration: McpLabFaultDeclaration): void {
  const untypedDeclaration: unknown = declaration;
  if (!isRecord(untypedDeclaration)) {
    throw new Error('Invalid MCP lab fault declaration: expected an object');
  }
  const id = untypedDeclaration['id'];
  if (typeof id !== 'string' || id.length > 128 || !MCP_LAB_FAULT_ID_PATTERN.test(id)) {
    throw new Error('Invalid MCP lab fault id: expected a lowercase identifier');
  }
  if (!hasOnlyKeys(untypedDeclaration, ['fault', 'id', 'match'])) {
    throw new Error(
      `Invalid MCP lab fault "${id}": declaration must contain only "fault", "id", and "match"`
    );
  }
  const match = untypedDeclaration['match'];
  if (!(isRecord(match) && hasOnlyKeys(match, ['phase', 'method', 'occurrence']))) {
    throw new Error(
      `Invalid MCP lab fault "${id}": match must contain only "phase", "method", and "occurrence"`
    );
  }
}

function assertMatchProtocol(declaration: McpLabFaultDeclaration): void {
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
  if (phase === 'child-process' && declaration.match.occurrence !== 1) {
    throw new Error(
      `Invalid MCP lab fault "${declaration.id}": child-process coordinates require occurrence 1`
    );
  }
  assertFaultCoordinate(declaration);
}

function validateFaultDeclarations(declarations: readonly McpLabFaultDeclaration[]): void {
  const declaredIds = new Set<string>();
  const declaredMatches = new Map<string, string>();
  const shutdownDeclarations: McpLabFaultDeclaration[] = [];
  for (const declaration of declarations) {
    assertDeclarationShape(declaration);
    assertFaultPayload(declaration);
    assertMatchProtocol(declaration);
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
    if (declaration.match.phase === 'shutdown') {
      shutdownDeclarations.push(declaration);
    }
  }
  shutdownDeclarations.sort((left, right) => left.match.occurrence - right.match.occurrence);
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

function faultSupportsTransport(
  declaration: McpLabFaultDeclaration,
  transport: McpLabTransportKind
): boolean {
  if (declaration.match.phase === 'shutdown') {
    return true;
  }
  if (NON_CLIENT_EXECUTABLE_METHODS.has(declaration.match.method)) {
    return false;
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

function faultSupportsProtocolEra(
  declaration: McpLabFaultDeclaration,
  era: McpLabProtocolEra
): boolean {
  if (
    declaration.match.phase === 'authorization' ||
    declaration.match.phase === 'child-process' ||
    declaration.match.phase === 'shutdown' ||
    declaration.match.phase === 'transport'
  ) {
    return true;
  }
  return era === 'modern'
    ? !LEGACY_ONLY_METHODS.has(declaration.match.method)
    : !MODERN_ONLY_METHODS.has(declaration.match.method);
}

function transportForScenario(
  scenario: McpLabScenario,
  execution: McpLabExecution
): McpLabTransportKind {
  if (execution !== undefined && execution !== 'in-process' && execution !== 'loopback') {
    throw new Error('Invalid MCP lab execution mode');
  }
  if (getMcpLabScenario(scenario.id) !== scenario) {
    throw new Error('Invalid MCP lab scenario manifest');
  }
  if (scenario.transport === 'stdio') {
    if (execution !== undefined) {
      throw new Error('MCP lab stdio scenario does not accept an execution mode');
    }
    return 'stdio';
  }
  if (execution === undefined) {
    throw new Error('MCP lab streamable HTTP scenario requires an execution mode');
  }
  return execution === 'in-process' ? 'http-in-process' : 'http-loopback';
}

export function assertScenarioFaultCompatibility(
  faultPlan: McpLabFaultPlan | undefined,
  scenario: McpLabScenario,
  execution: McpLabExecution
): void {
  const transport = transportForScenario(scenario, execution);
  if (faultPlan === undefined) {
    return;
  }
  if (!isMcpLabFaultPlan(faultPlan)) {
    throw new Error('Invalid MCP lab fault plan');
  }
  faultPlan.assertCompatibleWithAuthentication(scenario.authentication);
  faultPlan.assertCompatibleWithProtocolEra(scenario.protocol.era);
  faultPlan.assertCompatibleWithTransport(transport);
  faultPlan.assertCompatibleWithFixture(scenario.fixture);
}

export function createMcpLabFaultPlan(
  declarations: readonly McpLabFaultDeclaration[]
): McpLabFaultPlan {
  const snapshots = snapshotDeclarations(declarations);
  validateFaultDeclarations(snapshots);

  const immutableDeclarations = snapshots.map(freezeDeclaration);
  const remaining = new Map(
    immutableDeclarations.map((declaration) => [matchKey(declaration.match), declaration] as const)
  );
  const consumed = new Map<string, McpLabFaultDeclaration>();
  const observations: McpLabFaultObservation[] = [];
  const executionTracker = createMcpLabFaultExecutionTracker(
    immutableDeclarations.map((declaration) => declaration.id)
  );
  let ownership: 'claimed' | 'fresh' | 'preconsumed' = 'fresh';

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
    executionTracker.observe(declaration.id);
    return declaration.fault;
  }

  function assertPublicMutationAllowed(): void {
    if (ownership === 'claimed') {
      throw new Error('MCP lab fault plan is claimed by a session');
    }
  }

  function exhaustedFault(key: string): McpLabFaultDeclaration | undefined {
    return consumed.get(key);
  }

  function consumeOptional(
    consumption: McpLabFaultConsumption,
    beforeMutation?: () => void
  ): McpLabFault | undefined {
    const snapshot = snapshotConsumption(consumption);
    beforeMutation?.();
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
  }

  function consumeStrict(
    consumption: McpLabFaultConsumption,
    beforeMutation?: () => void
  ): McpLabFault {
    const snapshot = snapshotConsumption(consumption);
    beforeMutation?.();
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
    throw new Error(
      `No MCP lab fault matches ${snapshot.phase}/${snapshot.method} occurrence ${snapshot.occurrence}`
    );
  }

  function hasRemainingPhase(phase: McpLabProtocolPhase): boolean {
    for (const declaration of remaining.values()) {
      if (declaration.match.phase === phase) {
        return true;
      }
    }
    return false;
  }

  function untriggeredIds(): readonly string[] {
    return Object.freeze([...remaining.values()].map((declaration) => declaration.id).sort());
  }

  const plan: McpLabFaultPlan = Object.freeze({
    assertCompatibleWithAuthentication(authentication: McpLabAuthentication) {
      if (authentication !== 'none' && authentication !== 'oauth') {
        throw new Error('Invalid MCP lab authentication mode');
      }
      const incompatible = immutableDeclarations.find(
        (declaration) => declaration.match.phase === 'authorization' && authentication !== 'oauth'
      );
      if (!incompatible) {
        return;
      }
      throw new Error(
        `MCP lab fault "${incompatible.id}" at ${incompatible.match.phase}/${incompatible.match.method} is incompatible with ${authentication} authentication`
      );
    },
    assertCompatibleWithFixture(fixture: McpLabFixture) {
      if (!Object.hasOwn(OPERATIONS_BY_FIXTURE, fixture)) {
        throw new Error('Invalid MCP lab fixture');
      }
      const supportedOperations = OPERATIONS_BY_FIXTURE[fixture];
      const incompatible = immutableDeclarations.find(
        (declaration) =>
          declaration.match.phase === 'operation' &&
          !supportedOperations.includes(declaration.match.method as McpLabOperationMethod)
      );
      if (!incompatible) {
        return;
      }
      throw new Error(
        `MCP lab fault "${incompatible.id}" at operation/${incompatible.match.method} is unsupported by fixture ${fixture}`
      );
    },
    assertCompatibleWithProtocolEra(era: McpLabProtocolEra) {
      if (era !== 'legacy' && era !== 'modern') {
        throw new Error('Invalid MCP lab protocol era');
      }
      const incompatible = immutableDeclarations.find(
        (declaration) => !faultSupportsProtocolEra(declaration, era)
      );
      if (!incompatible) {
        return;
      }
      throw new Error(
        `MCP lab fault "${incompatible.id}" at ${incompatible.match.phase}/${incompatible.match.method} is absent from the ${era} protocol registry`
      );
    },
    assertCompatibleWithTransport(transport: McpLabTransportKind) {
      if (
        transport !== 'http-in-process' &&
        transport !== 'http-loopback' &&
        transport !== 'stdio'
      ) {
        throw new Error('Invalid MCP lab transport');
      }
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
      assertPublicMutationAllowed();
      const fault = consumeStrict(consumption, assertPublicMutationAllowed);
      ownership = 'preconsumed';
      return fault;
    },
    consumeIfConfigured(consumption: McpLabFaultConsumption) {
      assertPublicMutationAllowed();
      const fault = consumeOptional(consumption, assertPublicMutationAllowed);
      if (fault) {
        ownership = 'preconsumed';
      }
      return fault;
    },
    executionState: executionTracker.state,
    hasRemainingPhase,
    holdDelay(faultId: string): () => void {
      if (ownership !== 'fresh') {
        throw new Error('MCP lab delay holds must be acquired before session startup');
      }
      if (
        !immutableDeclarations.some((entry) => entry.id === faultId && entry.fault.kind === 'delay')
      ) {
        throw new Error(`MCP lab fault "${faultId}" is not a configured delay`);
      }
      return executionTracker.hold(faultId);
    },
    observations() {
      return Object.freeze(observations.slice());
    },
    untriggeredIds,
  });
  const claimedPlan: McpLabClaimedFaultPlan = Object.freeze({
    [MCP_LAB_CLAIMED_PLAN]: true as const,
    beginExecution: executionTracker.begin,
    configuredFault(match: McpLabFaultMatch) {
      return remaining.get(matchKey(match))?.fault;
    },
    consume: consumeStrict,
    consumeIfConfigured: consumeOptional,
    hasRemainingPhase,
    observations() {
      return Object.freeze(observations.slice());
    },
    untriggeredIds,
  });
  registerMcpLabFaultPlanClaim(plan, () => {
    if (ownership !== 'fresh') {
      throw new Error(
        ownership === 'claimed'
          ? 'MCP lab fault plan is already claimed by a session'
          : 'MCP lab fault plan was consumed before session startup'
      );
    }
    ownership = 'claimed';
    return claimedPlan;
  });
  return plan;
}
