// Pure http responders only. The SecretReadError responders live in
// secret-error-responses.ts because payload-shaping for one failure family is
// not a generic http helper — since BST-972 A3 made that classification
// structural, the split is organizational, no longer an Electron-coupling
// firewall (secret-error-responses no longer imports ../secrets).
import type http from 'node:http';
import type {
  AgentStreamInitializationStage,
  AssistantPostRejection,
  AssistantRejectionPayload,
  DesktopMemoryFeature,
} from '@brainstrike/assistant-service/types';

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
