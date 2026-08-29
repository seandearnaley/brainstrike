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
  transport: ['http/request', 'http/response'],
} as const;

export type McpLabProtocolPhase = keyof typeof PROTOCOL_METHODS_BY_PHASE;
export type McpLabProtocolMethod = (typeof PROTOCOL_METHODS_BY_PHASE)[McpLabProtocolPhase][number];

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

export interface McpLabChildStderrFault {
  readonly kind: 'child_stderr';
  readonly text: string;
}

export type McpLabChildSignal =
  | 'SIGABRT'
  | 'SIGALRM'
  | 'SIGBUS'
  | 'SIGCHLD'
  | 'SIGCONT'
  | 'SIGFPE'
  | 'SIGHUP'
  | 'SIGILL'
  | 'SIGINT'
  | 'SIGIO'
  | 'SIGIOT'
  | 'SIGKILL'
  | 'SIGPIPE'
  | 'SIGPOLL'
  | 'SIGPROF'
  | 'SIGPWR'
  | 'SIGQUIT'
  | 'SIGSEGV'
  | 'SIGSTKFLT'
  | 'SIGSTOP'
  | 'SIGSYS'
  | 'SIGTERM'
  | 'SIGTRAP'
  | 'SIGTSTP'
  | 'SIGTTIN'
  | 'SIGTTOU'
  | 'SIGURG'
  | 'SIGUSR1'
  | 'SIGUSR2'
  | 'SIGVTALRM'
  | 'SIGWINCH'
  | 'SIGXCPU'
  | 'SIGXFSZ';

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
  observations(): readonly McpLabFaultObservation[];
}

const CREATED_MCP_LAB_FAULT_PLANS = new WeakSet<object>();
const MAX_MCP_LAB_FAULT_DECLARATIONS = 1024;
const MCP_LAB_CORRELATION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/u;
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
  const snapshot: Record<string, unknown> = {};
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
  const fault = snapshotRecord(declaration['fault']);
  const match = snapshotRecord(declaration['match']);
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

function assertKnownFaultKind(declaration: McpLabFaultDeclaration): void {
  const kind = (declaration.fault as { readonly kind?: unknown }).kind;
  switch (kind) {
    case 'child_exit':
    case 'child_stderr':
    case 'drop_response':
    case 'malformed_json':
      return;
    case 'delay': {
      const { delayMs } = declaration.fault as McpLabDelayFault;
      if (!Number.isInteger(delayMs) || delayMs < 1 || delayMs > 60_000) {
        throw new Error(
          `Invalid MCP lab fault "${declaration.id}": delay must be an integer from 1 to 60000 ms`
        );
      }
      return;
    }
    case 'http_status': {
      const { status } = declaration.fault as McpLabHttpStatusFault;
      if (!Number.isInteger(status) || status < 400 || status > 599) {
        throw new Error(
          `Invalid MCP lab fault "${declaration.id}": HTTP status must be an integer from 400 to 599`
        );
      }
      return;
    }
    default:
      throw new Error(`Invalid MCP lab fault "${declaration.id}": unknown fault kind`);
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
    snapshots.push(freezeDeclaration(snapshotDeclaration(declaration)));
  }
  return snapshots;
}

export function createMcpLabFaultPlan(
  declarations: readonly McpLabFaultDeclaration[]
): McpLabFaultPlan {
  const immutableDeclarations = snapshotDeclarations(declarations);
  const declaredIds = new Set<string>();
  const declaredMatches = new Map<string, string>();
  for (const declaration of immutableDeclarations) {
    if (
      typeof declaration.id !== 'string' ||
      declaration.id.length > 128 ||
      !MCP_LAB_FAULT_ID_PATTERN.test(declaration.id)
    ) {
      throw new Error('Invalid MCP lab fault id: expected a lowercase identifier');
    }
    assertKnownFaultKind(declaration);
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

  const remaining = new Map(
    immutableDeclarations.map((declaration) => [matchKey(declaration.match), declaration] as const)
  );
  const consumed = new Map<string, McpLabFaultDeclaration>();
  const observations: McpLabFaultObservation[] = [];

  const plan: McpLabFaultPlan = Object.freeze({
    assertFullyConsumed() {
      if (remaining.size === 0) {
        return;
      }
      const untriggeredIds = [...remaining.values()].map((declaration) => declaration.id).sort();
      throw new Error(`Untriggered MCP lab faults: ${untriggeredIds.join(', ')}`);
    },
    consume(consumption: McpLabFaultConsumption) {
      const snapshot = snapshotConsumption(consumption);
      const key = matchKey(snapshot);
      const declaration = remaining.get(key);
      if (!declaration) {
        const exhausted = consumed.get(key);
        if (exhausted) {
          throw new Error(
            `MCP lab fault "${exhausted.id}" is exhausted for ${snapshot.phase}/${snapshot.method} occurrence ${snapshot.occurrence}`
          );
        }
        throw new Error(
          `No MCP lab fault matches ${snapshot.phase}/${snapshot.method} occurrence ${snapshot.occurrence}`
        );
      }

      remaining.delete(key);
      consumed.set(key, declaration);
      observations.push(
        Object.freeze({
          correlationId: snapshot.correlationId,
          faultId: declaration.id,
          faultKind: declaration.fault.kind,
          method: snapshot.method,
          occurrence: snapshot.occurrence,
          phase: snapshot.phase,
        })
      );
      return declaration.fault;
    },
    observations() {
      return Object.freeze(observations.slice());
    },
  });
  CREATED_MCP_LAB_FAULT_PLANS.add(plan);
  return plan;
}
