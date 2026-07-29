// Deliberately separate from http-responses.ts: these two responders import
// ../secrets (and through it electron/electron-store), while the plain
// responders are pure http helpers. Keeping the main-process-only dependency
// out of the responder floor lets later slices — and the eventual BST-972
// transport-independent extraction — depend on http-responses.ts without
// inheriting an Electron coupling.
import type http from 'node:http';
import { SecretReadError } from '../secrets';
import { respondJson } from './http-responses';

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
