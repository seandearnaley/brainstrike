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
      throw new Error(
        `Invalid MCP lab fault "${declaration.id}": unknown fault kind "${String(kind)}"`
      );
  }
}

function freezeDeclaration(declaration: McpLabFaultDeclaration): McpLabFaultDeclaration {
  return Object.freeze({
    fault: Object.freeze({ ...declaration.fault }) as McpLabFault,
    id: declaration.id,
    match: Object.freeze({ ...declaration.match }),
  });
}

export function createMcpLabFaultPlan(
  declarations: readonly McpLabFaultDeclaration[]
): McpLabFaultPlan {
  const declaredIds = new Set<string>();
  const declaredMatches = new Map<string, string>();
  for (const declaration of declarations) {
    assertKnownFaultKind(declaration);
    if (!Number.isSafeInteger(declaration.match.occurrence) || declaration.match.occurrence < 1) {
      throw new Error(
        `Invalid MCP lab fault "${declaration.id}": occurrence must be a positive safe integer`
      );
    }
    const methods = PROTOCOL_METHODS_BY_PHASE[declaration.match.phase];
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

  const immutableDeclarations = declarations.map(freezeDeclaration);
  const remaining = new Map(
    immutableDeclarations.map((declaration) => [matchKey(declaration.match), declaration] as const)
  );
  const consumed = new Map<string, McpLabFaultDeclaration>();
  const observations: McpLabFaultObservation[] = [];

  return {
    assertFullyConsumed() {
      if (remaining.size === 0) {
        return;
      }
      const untriggeredIds = [...remaining.values()].map((declaration) => declaration.id).sort();
      throw new Error(`Untriggered MCP lab faults: ${untriggeredIds.join(', ')}`);
    },
    consume(consumption) {
      const key = matchKey(consumption);
      const declaration = remaining.get(key);
      if (!declaration) {
        const exhausted = consumed.get(key);
        if (exhausted) {
          throw new Error(
            `MCP lab fault "${exhausted.id}" is exhausted for ${consumption.phase}/${consumption.method} occurrence ${consumption.occurrence}`
          );
        }
        throw new Error(
          `No MCP lab fault matches ${consumption.phase}/${consumption.method} occurrence ${consumption.occurrence}`
        );
      }

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
    },
    observations() {
      return Object.freeze(observations.slice());
    },
  };
}
