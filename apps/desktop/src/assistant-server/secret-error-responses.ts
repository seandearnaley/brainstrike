// Secret-read failure classification + responder. Classification is
// STRUCTURAL via assistant-contract's matchSecretReadError (BST-972 A3), so
// this module no longer carries the electron coupling (../secrets) that
// originally forced its separation from http-responses.ts; it stays a separate
// module because payload-shaping for one failure family is not a generic http
// helper. The conformance money test — the real SecretReadError through the
// structural matcher — lives in __tests__/secrets.test.ts.
import type http from 'node:http';
import { respondJson } from '@brainstrike/assistant-service/http';
import { getSecretReadErrorPayload } from '@brainstrike/assistant-service/secret-errors';

export function respondToSecretReadError(res: http.ServerResponse, error: unknown): boolean {
  const payload = getSecretReadErrorPayload(error);
  if (!payload) {
    return false;
  }
  respondJson(res, 400, payload);
  return true;
}
