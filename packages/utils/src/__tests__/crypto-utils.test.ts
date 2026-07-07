import { afterEach, describe, expect, it, vi } from 'vitest';

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@brainstrike/utils/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

import {
  generateContentHash,
  generateUUID,
  isCryptoRandomUUIDAvailable,
  isCryptoSubtleAvailable,
} from '../crypto-utils';

describe('crypto-utils', () => {
  // Store original methods
  const originalRandomUUID = globalThis.crypto?.randomUUID;
  const originalSubtle = globalThis.crypto?.subtle;
  const originalGetRandomValues = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto);

  afterEach(() => {
    // Restore original methods
    if (originalRandomUUID) {
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        configurable: true,
        value: originalRandomUUID,
        writable: true,
      });
    }
    if (originalSubtle) {
      Object.defineProperty(globalThis.crypto, 'subtle', {
        configurable: true,
        value: originalSubtle,
        writable: true,
      });
    }
    if (originalGetRandomValues) {
      Object.defineProperty(globalThis.crypto, 'getRandomValues', {
        configurable: true,
        value: originalGetRandomValues,
        writable: true,
      });
    }
    vi.restoreAllMocks();
  });

  describe('generateUUID', () => {
    it('uses crypto.randomUUID when available', () => {
      const mockUUID = '123e4567-e89b-12d3-a456-426614174000';

      // Mock crypto.randomUUID
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        configurable: true,
        value: vi.fn().mockReturnValue(mockUUID),
        writable: true,
      });

      const result = generateUUID();
      expect(result).toBe(mockUUID);
      expect(globalThis.crypto.randomUUID).toHaveBeenCalledOnce();
    });

    it('falls back to getRandomValues when randomUUID is unavailable', () => {
      // Remove crypto.randomUUID but keep getRandomValues
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        configurable: true,
        value: undefined,
        writable: true,
      });

      const spy = vi.spyOn(globalThis.crypto, 'getRandomValues');

      const result = generateUUID();

      // Should use getRandomValues
      expect(spy).toHaveBeenCalledOnce();
      // Should be a valid UUID v4 format
      expect(result).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it('throws when secure UUID APIs are unavailable', () => {
      // Remove both crypto.randomUUID and crypto.getRandomValues
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        configurable: true,
        value: undefined,
        writable: true,
      });
      Object.defineProperty(globalThis.crypto, 'getRandomValues', {
        configurable: true,
        value: undefined,
        writable: true,
      });

      expect(() => generateUUID()).toThrowError(
        'Secure UUID generation requires crypto.randomUUID or crypto.getRandomValues.'
      );
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('generates unique UUIDs each time with fallback', () => {
      // Remove crypto.randomUUID to force fallback
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        configurable: true,
        value: undefined,
        writable: true,
      });

      const uuid1 = generateUUID();
      const uuid2 = generateUUID();

      expect(uuid1).not.toBe(uuid2);
      expect(uuid1).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
      expect(uuid2).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });
  });

  describe('generateContentHash', () => {
    it('uses crypto.subtle.digest when available', async () => {
      const mockHash = new Uint8Array([1, 2, 3, 4]);
      const mockDigest = vi.fn().mockResolvedValue(mockHash.buffer);

      // Mock crypto.subtle
      Object.defineProperty(globalThis.crypto, 'subtle', {
        configurable: true,
        value: { digest: mockDigest },
        writable: true,
      });

      const result = await generateContentHash('test content');

      expect(mockDigest).toHaveBeenCalledWith('SHA-256', expect.any(Uint8Array));
      expect(result).toBe('01020304');
    });

    it('falls back when crypto.subtle is not available', async () => {
      // Remove crypto.subtle
      Object.defineProperty(globalThis.crypto, 'subtle', {
        configurable: true,
        value: undefined,
        writable: true,
      });

      const result = await generateContentHash('test content');

      // Should return a deterministic hex string
      expect(result).toMatch(/^[0-9a-f]{32}$/);
    });

    it('falls back when crypto.subtle.digest throws an error', async () => {
      const mockDigest = vi.fn().mockRejectedValue(new Error('crypto.subtle error'));

      // Mock crypto.subtle with failing digest
      Object.defineProperty(globalThis.crypto, 'subtle', {
        configurable: true,
        value: { digest: mockDigest },
        writable: true,
      });

      const result = await generateContentHash('test content');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'crypto.subtle.digest failed, using fallback hash',
        { error: expect.any(Error) }
      );
      expect(result).toMatch(/^[0-9a-f]{32}$/);
    });

    it('generates consistent hashes for the same content', async () => {
      // Force fallback
      Object.defineProperty(globalThis.crypto, 'subtle', {
        configurable: true,
        value: undefined,
        writable: true,
      });

      const content = 'test content for hashing';
      const hash1 = await generateContentHash(content);
      const hash2 = await generateContentHash(content);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[0-9a-f]{32}$/);
    });

    it('generates different hashes for different content', async () => {
      // Force fallback
      Object.defineProperty(globalThis.crypto, 'subtle', {
        configurable: true,
        value: undefined,
        writable: true,
      });

      const hash1 = await generateContentHash('content 1');
      const hash2 = await generateContentHash('content 2');

      expect(hash1).not.toBe(hash2);
      expect(hash1).toMatch(/^[0-9a-f]{32}$/);
      expect(hash2).toMatch(/^[0-9a-f]{32}$/);
    });

    it('handles empty content', async () => {
      // Force fallback
      Object.defineProperty(globalThis.crypto, 'subtle', {
        configurable: true,
        value: undefined,
        writable: true,
      });

      const result = await generateContentHash('');

      expect(result).toMatch(/^[0-9a-f]{32}$/);
    });

    it('handles large content', async () => {
      // Force fallback
      Object.defineProperty(globalThis.crypto, 'subtle', {
        configurable: true,
        value: undefined,
        writable: true,
      });

      const largeContent = 'a'.repeat(10_000);
      const result = await generateContentHash(largeContent);

      expect(result).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  describe('isCryptoSubtleAvailable', () => {
    it('returns true when crypto.subtle.digest is available', () => {
      // Ensure crypto.subtle is available with digest method
      Object.defineProperty(globalThis.crypto, 'subtle', {
        configurable: true,
        value: { digest: vi.fn() },
        writable: true,
      });

      expect(isCryptoSubtleAvailable()).toBe(true);
    });

    it('returns false when crypto.subtle is undefined', () => {
      // Remove crypto.subtle
      Object.defineProperty(globalThis.crypto, 'subtle', {
        configurable: true,
        value: undefined,
        writable: true,
      });

      expect(isCryptoSubtleAvailable()).toBe(false);
    });

    it('returns false when crypto.subtle.digest is not a function', () => {
      // Set crypto.subtle with invalid digest
      Object.defineProperty(globalThis.crypto, 'subtle', {
        configurable: true,
        value: { digest: 'not a function' },
        writable: true,
      });

      expect(isCryptoSubtleAvailable()).toBe(false);
    });
  });

  describe('isCryptoRandomUUIDAvailable', () => {
    it('returns true when crypto.randomUUID is available', () => {
      // Ensure crypto.randomUUID is available
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        configurable: true,
        value: vi.fn(),
        writable: true,
      });

      expect(isCryptoRandomUUIDAvailable()).toBe(true);
    });

    it('returns false when crypto.randomUUID is undefined', () => {
      // Remove crypto.randomUUID
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        configurable: true,
        value: undefined,
        writable: true,
      });

      expect(isCryptoRandomUUIDAvailable()).toBe(false);
    });

    it('returns false when crypto.randomUUID is not a function', () => {
      // Set crypto.randomUUID to invalid value
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        configurable: true,
        value: 'not a function',
        writable: true,
      });

      expect(isCryptoRandomUUIDAvailable()).toBe(false);
    });
  });
});
