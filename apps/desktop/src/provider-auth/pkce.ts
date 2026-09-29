import { createHash, randomBytes } from 'node:crypto';

/**
 * PKCE + state primitives for the provider-auth OAuth engine (BST-1355).
 * Pure node:crypto — no new dependencies (RFC 7636).
 */

/** RFC 7636 §4.1 unreserved characters: ALPHA / DIGIT / "-" / "." / "_" / "~". */
const PKCE_UNRESERVED_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

/** Minimum RFC 7636 verifier length; 43 chars of a 66-symbol alphabet is
 * ~260 bits of entropy, comfortably above the 256-bit recommendation. */
export const PKCE_VERIFIER_LENGTH = 43;

// Rejection-sampling bound: the largest multiple of the alphabet size that
// fits in a byte. Accepting only bytes below it keeps every alphabet index
// equally likely (no modulo bias).
const ALPHABET_SIZE = PKCE_UNRESERVED_ALPHABET.length; // 66
const REJECTION_BOUND = Math.floor(256 / ALPHABET_SIZE) * ALPHABET_SIZE; // 198

/**
 * Generate an RFC 7636 code_verifier: {@link PKCE_VERIFIER_LENGTH} characters
 * drawn uniformly from the unreserved alphabet via crypto.randomBytes
 * rejection sampling.
 */
export function createPkceVerifier(): string {
  const characters: string[] = [];
  while (characters.length < PKCE_VERIFIER_LENGTH) {
    const bytes = randomBytes(PKCE_VERIFIER_LENGTH);
    for (const byte of bytes) {
      if (byte >= REJECTION_BOUND) {
        continue;
      }
      characters.push(PKCE_UNRESERVED_ALPHABET[byte % ALPHABET_SIZE] as string);
      if (characters.length === PKCE_VERIFIER_LENGTH) {
        break;
      }
    }
  }
  return characters.join('');
}

/** RFC 7636 §4.2 S256: base64url(SHA-256(ascii(verifier))), no padding. */
export function computeS256Challenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** CSRF-binding `state` parameter: 32 random bytes, unpadded base64url. */
export function createState(): string {
  return randomBytes(32).toString('base64url');
}
