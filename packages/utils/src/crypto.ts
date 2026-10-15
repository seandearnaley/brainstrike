/**
 * Cross-platform utilities backed by secure runtime crypto APIs.
 */
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';

/** Node's native crypto where the runtime provides it (desktop); `@noble/hashes` elsewhere (the browser). */
const nodeCrypto = globalThis.process?.getBuiltinModule?.('node:crypto');
const utf8 = new TextEncoder();

function hexOf(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) {
    text += byte.toString(16).padStart(2, '0');
  }
  return text;
}

/**
 * SHA-256 of `input` (a string as its UTF-8 bytes), computed synchronously
 * on every runtime: for code that must hash inside a synchronous read, such
 * as the derived index and the browser state writer.
 */
export function sha256Bytes(input: string | Uint8Array): Uint8Array {
  return nodeCrypto
    ? new Uint8Array(nodeCrypto.createHash('sha256').update(input).digest())
    : nobleSha256(typeof input === 'string' ? utf8.encode(input) : input);
}

/** `sha256Bytes` as lowercase hex. */
export function sha256Hex(input: string | Uint8Array): string {
  return nodeCrypto
    ? nodeCrypto.createHash('sha256').update(input).digest('hex')
    : hexOf(nobleSha256(typeof input === 'string' ? utf8.encode(input) : input));
}

/**
 * Generate a UUID using secure runtime crypto APIs.
 * Throws when secure entropy is unavailable instead of silently degrading to Math.random.
 */
export function generateUUID(): string {
  // Try crypto.randomUUID if available (modern browsers and Node.js 16+)
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  // Fallback to manual UUID v4 generation
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    // Set version to 4
    // biome-ignore lint/style/noNonNullAssertion: Uint8Array of known length, index always valid
    array[6] = (array[6]! & 0x0f) | 0x40;
    // Set variant to RFC 4122
    // biome-ignore lint/style/noNonNullAssertion: Uint8Array of known length, index always valid
    array[8] = (array[8]! & 0x3f) | 0x80;

    let result = '';
    for (let i = 0; i < 16; i++) {
      if (i === 4 || i === 6 || i === 8 || i === 10) {
        result += '-';
      }
      // biome-ignore lint/style/noNonNullAssertion: Uint8Array of known length, index always valid
      result += array[i]!.toString(16).padStart(2, '0');
    }
    return result;
  }

  throw new Error('Secure UUID generation requires crypto.randomUUID or crypto.getRandomValues.');
}

/**
 * Generate a SHA-256 content hash.
 */
export async function generateContentHash(content: string): Promise<string> {
  if (!isCryptoSubtleAvailable()) {
    throw new Error('Content hashing requires crypto.subtle.digest.');
  }

  const data = new TextEncoder().encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  if (hashBuffer.byteLength !== 32) {
    throw new Error(`SHA-256 returned an invalid ${hashBuffer.byteLength}-byte digest.`);
  }

  return Array.from(new Uint8Array(hashBuffer), (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
}

/**
 * Check if crypto.subtle is available (secure context required)
 */
export function isCryptoSubtleAvailable(): boolean {
  return (
    typeof crypto !== 'undefined' &&
    crypto.subtle !== undefined &&
    typeof crypto.subtle.digest === 'function'
  );
}

/**
 * Check if crypto.randomUUID is available
 */
export function isCryptoRandomUUIDAvailable(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function';
}
