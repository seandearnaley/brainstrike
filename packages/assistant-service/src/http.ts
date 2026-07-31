/**
 * Transport adapters for the run service (BST-973, "share down, not across"):
 * the pieces BOTH hosts can carry without wire change, split by target.
 * - WHATWG side (hosted web): a rejection -> Response
 *   mapper byte-identical to web's previous local builder (Cache-Control:
 *   no-store; closeConnection is a Node-transport instruction with no WHATWG
 *   counterpart — ignoring it matches web today).
 * - node:http side (desktop): the JSON responders moved verbatim from
 *   apps/desktop/src/assistant-server/http-responses.ts (which was already
 *   service-typed and mocked by NO suite). streamResponse/writeHeaders stay
 *   on the desktop specifier: six suites stub exactly those two, and web can
 *   never use a WHATWG->ServerResponse pump.
 * Everything web deliberately removed (sessions, persistence, the desktop
 * provider policy) stays out — see the BST-973 premise correction on the
 * ticket.
 */
import type http from 'node:http';
import type {
  AgentStreamInitializationStage,
  AssistantPostRejection,
  AssistantRejectionPayload,
} from '@brainstrike/assistant-wire';
import type { DesktopMemoryFeature } from './types.js';

/** Shared JSON error headers for WHATWG hosts (web's exact bytes). */
export const ASSISTANT_JSON_ERROR_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
} as const;

/**
 * WHATWG mapper: a rejection becomes a JSON Response. WHATWG hosts have no
 * connection to instruct, so a rejection carrying `closeConnection: true` is
 * REJECTED AT THE TYPE LEVEL rather than silently dropped (NO SILENT
 * FALLBACKS): a caller holding a connection-close rejection must handle the
 * instruction on its own transport before mapping.
 */
export function createAssistantRejectionResponse(rejection: {
  readonly closeConnection?: undefined;
  readonly payload: AssistantRejectionPayload;
  readonly status: number;
}): Response {
  return new Response(JSON.stringify(rejection.payload), {
    headers: ASSISTANT_JSON_ERROR_HEADERS,
    status: rejection.status,
  });
}

/**
 * Write a request-preparation rejection to the response (BST-972 A4). Not
 * `respondJson`: rejection payloads may be deliberately message-less
 * (`empty_prompt`), and the 413 body-limit rejection carries the
 * connection-close instruction the transport must honor.
 */
export function respondAssistantRejection(
  res: http.ServerResponse,
  rejection: AssistantPostRejection
): void {
  if (rejection.closeConnection) {
    res.setHeader('Connection', 'close');
  }
  writeJsonPayload(res, rejection.status, rejection.payload);
}

/**
 * The single JSON-error writer both responders delegate to, so a future change
 * to the write mechanics (Content-Length, nosniff, a headersSent guard) cannot
 * land on one and silently miss the other. Takes the widest payload shape;
 * respondJson narrows to require `message`.
 */
function writeJsonPayload(
  res: http.ServerResponse,
  status: number,
  payload: AssistantRejectionPayload & { readonly feature?: DesktopMemoryFeature }
): void {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = status;
  res.end(JSON.stringify(payload));
}

export function respondNotFound(res: http.ServerResponse): void {
  res.writeHead(404).end('not found');
}

export function respondJson(
  res: http.ServerResponse,
  status: number,
  payload: {
    code?: string;
    correlationId?: string;
    error: string;
    feature?: DesktopMemoryFeature;
    message: string;
    provider?: string;
    reason?: string;
    stage?: AgentStreamInitializationStage;
  }
): void {
  writeJsonPayload(res, status, payload);
}
