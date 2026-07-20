import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Auth configuration for the assistant HTTP server. `'disabled'` is an
 * explicit, visible opt-out (tests exercising routing/CORS concerns) — leaving
 * auth unset is a configuration error and the request handler throws on it, so
 * the gate can never be skipped silently.
 */
export type AssistantServerAuth = { token: string } | 'disabled';

/** Mints the per-boot capability token (32 random bytes as 64 hex chars). */
export function mintAssistantServerAuthToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Constant-time comparison of a request header value against the expected
 * token. Non-string values (missing header, repeated header arrays) and
 * length mismatches are rejected outright — length is the only property this
 * leaks, and tokens are fixed-length.
 */
export function isAuthorizedAssistantToken(headerValue: unknown, expectedToken: string): boolean {
  if (typeof headerValue !== 'string' || headerValue.length === 0) {
    return false;
  }
  const provided = Buffer.from(headerValue, 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  if (provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(provided, expected);
}
