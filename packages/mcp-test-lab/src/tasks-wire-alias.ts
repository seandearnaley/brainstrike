import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';

/**
 * The pinned SDK v2 core still registers the pre-2026-07-28 Tasks shape
 * (`tasks/get`, `tasks/cancel`, ...) as spec methods and physically deletes
 * them from the 2026-07-28 wire codec on BOTH ends: the client refuses to send
 * them and the server answers method-not-found before dispatch. Its response
 * funnel likewise admits only `complete`/`input_required` result types. The
 * Tasks extension (SEP-2663) reuses those names and adds the `task` result
 * type, so a black-box proof over the real wire needs the same closed alias
 * bridge the production client uses: the SDK sees non-colliding consumer
 * methods and `complete` results; only the transport boundary carries the
 * official wire shape. Nothing else is rewritten.
 */
export const TASKS_WIRE_ALIASES = Object.freeze({
  'tasks/cancel': 'brainstrike-lab/tasks/cancel',
  'tasks/get': 'brainstrike-lab/tasks/get',
  'tasks/update': 'brainstrike-lab/tasks/update',
} as const);

export type TasksWireMethod = keyof typeof TASKS_WIRE_ALIASES;

/** Key under which a `task` tool result crosses the SDK funnel as `complete`. */
export const TASKS_LAB_RESULT_KEY = 'brainstrike-lab/task-result';
const TASK_RESULT_TYPE = 'task';

const ALIAS_TO_WIRE: ReadonlyMap<string, TasksWireMethod> = new Map(
  (Object.keys(TASKS_WIRE_ALIASES) as TasksWireMethod[]).map((wire) => [
    TASKS_WIRE_ALIASES[wire],
    wire,
  ])
);

type Request = JSONRPCMessage & { readonly id: string | number; readonly method: string };
type Rewrite = (message: JSONRPCMessage) => JSONRPCMessage;

function isRequest(message: JSONRPCMessage): message is Request {
  return 'id' in message && 'method' in message && typeof message.method === 'string';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rewrites inbound messages before the SDK handler sees them. The SDK's
 * connect reads the existing handler and chains it from inside its own, so a
 * rewritten message re-enters here once; the active set passes it through.
 */
function interceptInbound(transport: Transport, rewrite: Rewrite): void {
  let downstream = transport.onmessage;
  const active = new WeakSet<object>();
  const handler: NonNullable<Transport['onmessage']> = (message, extra) => {
    if (active.has(message)) {
      return;
    }
    if (downstream === undefined) {
      throw new Error('MCP Tasks lab transport received a message before connect');
    }
    const rewritten = rewrite(message);
    active.add(rewritten);
    try {
      downstream(rewritten, extra);
    } finally {
      active.delete(rewritten);
    }
  };
  Object.defineProperty(transport, 'onmessage', {
    configurable: true,
    enumerable: true,
    get: () => handler,
    set: (next: Transport['onmessage']) => {
      if (next !== handler) {
        downstream = next;
      }
    },
  });
}

/**
 * Client side: the SDK sends aliases and receives `complete` results; the
 * wire carries the official methods and the `task` result type.
 */
export function installTasksClientWireAlias<OwnedTransport extends Transport>(
  transport: OwnedTransport
): OwnedTransport {
  const pendingToolCalls = new Set<string | number>();
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    if (!isRequest(message)) {
      // A locally abandoned request never gets a response; the SDK announces
      // it with notifications/cancelled, the only signal this layer sees.
      if ('method' in message && message.method === 'notifications/cancelled') {
        const requestId = (message.params as { requestId?: unknown } | undefined)?.requestId;
        if (typeof requestId === 'string' || typeof requestId === 'number') {
          pendingToolCalls.delete(requestId);
        }
      }
      return send(message, options);
    }
    if (message.method === 'tools/call') {
      pendingToolCalls.add(message.id);
    }
    const wire = ALIAS_TO_WIRE.get(message.method);
    return send(wire === undefined ? message : { ...message, method: wire }, options);
  };
  const close = transport.close.bind(transport);
  transport.close = async () => {
    pendingToolCalls.clear();
    await close();
  };
  interceptInbound(transport, (message) => {
    const id = 'id' in message ? message.id : undefined;
    // Ids are per direction: a server-initiated request may reuse a client id,
    // so only an actual response consumes the pending marker.
    if (id === undefined || !('result' in message) || !pendingToolCalls.delete(id)) {
      return message;
    }
    const result: unknown = message.result;
    if (!isObject(result) || result['resultType'] !== TASK_RESULT_TYPE) {
      return message;
    }
    return {
      ...message,
      result: { [TASKS_LAB_RESULT_KEY]: result, content: [], resultType: 'complete' },
    };
  });
  return transport;
}

/** Recovers the wire `task` tool result the client bridge wrapped, or the raw result. */
export function unwrapTasksToolResult(raw: unknown): unknown {
  return isObject(raw) && TASKS_LAB_RESULT_KEY in raw ? raw[TASKS_LAB_RESULT_KEY] : raw;
}

/**
 * The SDK funnel lifts `resultType: 'complete'` off every admitted result;
 * the extension schemas require it, so restore it before parsing.
 */
export function restoreCompleteResultType(raw: unknown): unknown {
  return isObject(raw) && !('resultType' in raw) ? { ...raw, resultType: 'complete' } : raw;
}

/** Server side: the wire carries the official methods; the SDK dispatches the aliases. */
export function installTasksServerWireAlias(server: McpServer): McpServer {
  const connect = server.connect.bind(server);
  server.connect = (transport) => {
    interceptInbound(transport, (message) => {
      if (!(isRequest(message) && message.method in TASKS_WIRE_ALIASES)) {
        return message;
      }
      return { ...message, method: TASKS_WIRE_ALIASES[message.method as TasksWireMethod] };
    });
    return connect(transport);
  };
  return server;
}
