/**
 * Cross-platform crypto utilities with fallbacks for non-secure contexts
 */
import { createLogger } from '@brainstrike/utils/logger';

const logger = createLogger('CryptoUtils');

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
 * Generate SHA-256 hash with fallback for non-secure contexts
 */
export async function generateContentHash(content: string): Promise<string> {
  // Try crypto.subtle if available (HTTPS contexts and modern Node.js)
  if (crypto?.subtle?.digest) {
    try {
      const encoder = new TextEncoder();
      const data = encoder.encode(content);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (error) {
      // Fall through to fallback if crypto.subtle fails
      logger.warn('crypto.subtle.digest failed, using fallback hash', { error });
    }
  }

  // Fallback to a simple but deterministic hash function
  return generateFallbackHash(content);
}

/**
 * Simple deterministic hash function for content deduplication
 * Not cryptographically secure but sufficient for content comparison
 */
function generateFallbackHash(content: string): string {
  let hash = 0;

  // Use a better hash algorithm than the basic one in stableHash
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash &= hash; // Convert to 32bit integer
  }

  // Convert to hex and pad to simulate SHA-256 length (but much shorter)
  const hex = Math.abs(hash).toString(16).padStart(8, '0');

  // Extend to make it look more like a real hash (for consistency with existing data)
  // Repeat the pattern to create a longer hash while maintaining determinism
  const extended = (hex + hex + hex + hex).slice(0, 32);

  return extended;
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
