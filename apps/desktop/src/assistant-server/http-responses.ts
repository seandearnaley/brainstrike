import type http from 'node:http';
import { SecretReadError } from '../secrets';
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

export function getSecretReadErrorPayload(error: unknown):
  | {
      code: string;
      error: 'api_key_unreadable';
      message: string;
      provider: string;
    }
  | undefined {
  if (!(error instanceof SecretReadError)) {
    return;
  }
  return {
    code: error.code,
    error: 'api_key_unreadable',
    message: error.message,
    provider: error.provider,
  };
}

export function respondToSecretReadError(res: http.ServerResponse, error: unknown): boolean {
  const payload = getSecretReadErrorPayload(error);
  if (!payload) {
    return false;
  }
  respondJson(res, 400, payload);
  return true;
}
