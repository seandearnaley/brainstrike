// Pure http responders only. The SecretReadError responders live in
// secret-error-responses.ts so this floor module never imports ../secrets
// (and through it electron) — later slices and the BST-972 extraction depend
// on this file staying main-process-agnostic.
import type http from 'node:http';
import type { AgentStreamInitializationStage, DesktopMemoryFeature } from './server-types';

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
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = status;
  res.end(JSON.stringify(payload));
}
