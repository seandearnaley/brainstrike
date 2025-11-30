/**
 * Cross-platform crypto utilities with fallbacks for non-secure contexts
 */
import { createLogger } from './logger';

const logger = createLogger('CryptoUtils');

/**
 * Generate a UUID with fallback for environments without crypto.randomUUID
 */
export function generateUUID(): string {
  // Try crypto.randomUUID if available (modern browsers and Node.js 16+)
  if (crypto?.randomUUID) {
    return crypto.randomUUID();
  }

  // Fallback to manual UUID v4 generation
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
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
  const extended = (hex + hex + hex + hex).substring(0, 32);

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
