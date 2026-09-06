/**
 * The MCP lab's protocol VOCABULARY: which method belongs to which fault phase,
 * which coordinates each reference fixture actually implements, and which of
 * them the lab can drive from the client side per protocol era.
 *
 * Split out of `faults.ts` (BST-1592) so that file stays under the per-file
 * line bound; this module is data plus two total predicates over it, with no
 * fault-plan state of its own.
 */
import type { McpLabFixture } from './scenario.js';

export type McpLabProtocolEra = 'legacy' | 'modern';

export const PROTOCOL_METHODS_BY_PHASE = {
  authorization: [
    'oauth/protected-resource',
    'oauth/authorization-server',
    'oauth/register',
    'oauth/authorize',
    'oauth/token',
  ],
  'child-process': ['child/spawn', 'child/stderr', 'child/exit'],
  initialization: ['initialize', 'notifications/initialized', 'ping', 'server/discover'],
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
    'notifications/elicitation/complete',
    'notifications/message',
    'notifications/progress',
    'notifications/prompts/list_changed',
    'notifications/resources/list_changed',
    'notifications/resources/updated',
    'notifications/roots/list_changed',
    'notifications/subscriptions/acknowledged',
    'notifications/tasks/status',
    'notifications/tools/list_changed',
  ],
  transport: ['http/request', 'http/response', 'node/dispatch'],
} as const;

export type McpLabProtocolPhase = keyof typeof PROTOCOL_METHODS_BY_PHASE;
export type McpLabProtocolMethod = (typeof PROTOCOL_METHODS_BY_PHASE)[McpLabProtocolPhase][number];
export type McpLabOperationMethod = (typeof PROTOCOL_METHODS_BY_PHASE)['operation'][number];

/** The stdio and Tasks fixtures serve tools only. */
const ECHO_FIXTURE_OPERATIONS = Object.freeze([
  'tools/call',
  'tools/list',
] as const satisfies readonly McpLabOperationMethod[]);
/**
 * Fixtures that additionally serve resources and a completable prompt: the
 * official everything reference, and — since BST-1592 — the HTTP echo
 * reference that backs the packaged content proof.
 */
const CONTENT_FIXTURE_OPERATIONS = Object.freeze([
  'completion/complete',
  'prompts/get',
  'prompts/list',
  'resources/list',
  'resources/read',
  'tools/call',
  'tools/list',
] as const satisfies readonly McpLabOperationMethod[]);
const APPS_FIXTURE_OPERATIONS = Object.freeze([
  'resources/list',
  'resources/read',
  'tools/call',
  'tools/list',
] as const satisfies readonly McpLabOperationMethod[]);
export const OPERATIONS_BY_FIXTURE: Readonly<
  Record<McpLabFixture, readonly McpLabOperationMethod[]>
> = Object.freeze({
  'brainstrike-apps-reference': APPS_FIXTURE_OPERATIONS,
  'brainstrike-oauth-reference': CONTENT_FIXTURE_OPERATIONS,
  'brainstrike-sdk-v2-reference': CONTENT_FIXTURE_OPERATIONS,
  'brainstrike-stdio-reference': ECHO_FIXTURE_OPERATIONS,
  'brainstrike-tasks-reference': ECHO_FIXTURE_OPERATIONS,
  'official-sdk-v2-everything-reference': CONTENT_FIXTURE_OPERATIONS,
});

// Exact client-to-server coordinates implemented by the reference fixtures.
// The complete pinned SDK era registry remains a separate compatibility gate below.
const EXECUTABLE_PROTOCOL_METHODS_BY_ERA = Object.freeze({
  legacy: new Set<McpLabProtocolMethod>([
    'completion/complete',
    'initialize',
    'notifications/cancelled',
    'notifications/initialized',
    'notifications/progress',
    'notifications/roots/list_changed',
    'ping',
    'prompts/get',
    'prompts/list',
    'resources/list',
    'resources/read',
    'tools/call',
    'tools/list',
  ]),
  modern: new Set<McpLabProtocolMethod>([
    'completion/complete',
    'notifications/cancelled',
    'notifications/progress',
    'prompts/get',
    'prompts/list',
    'resources/list',
    'resources/read',
    'server/discover',
    'subscriptions/listen',
    'tools/call',
    'tools/list',
  ]),
});

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

/**
 * Whether the lab can drive `method` from the client side in `era` — the set of
 * coordinates the reference fixtures implement, not the full SDK registry.
 */
export function isExecutableProtocolMethod(
  method: string,
  era: McpLabProtocolEra
): method is McpLabProtocolMethod {
  return EXECUTABLE_PROTOCOL_METHODS_BY_ERA[era].has(method as McpLabProtocolMethod);
}
