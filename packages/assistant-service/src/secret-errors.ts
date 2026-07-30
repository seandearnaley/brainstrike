/**
 * Secret-read failure payload shaping (BST-972 B2, split from ./request on
 * review: consumers that only classify credential failures — the desktop
 * responder and provider-credentials behind it — should not pull the whole
 * request-preparation graph for one function).
 */
import { matchSecretReadError } from '@brainstrike/assistant-contract';

export function getSecretReadErrorPayload(error: unknown):
  | {
      code: string;
      error: 'api_key_unreadable';
      message: string;
      provider: string;
    }
  | undefined {
  const match = matchSecretReadError(error);
  if (!match) {
    return;
  }
  return {
    code: match.code,
    error: 'api_key_unreadable',
    message: match.message,
    provider: match.provider,
  };
}
