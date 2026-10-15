import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  generateContentHash,
  generateUUID,
  isCryptoRandomUUIDAvailable,
  isCryptoSubtleAvailable,
  sha256Bytes,
  sha256Hex,
} from '../crypto.js';

describe('crypto', () => {
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
    it('returns an exact 64-character SHA-256 digest', async () => {
      const mockHash = new Uint8Array(32);
      for (let index = 0; index < mockHash.length; index += 1) {
        mockHash[index] = index;
      }
      const mockDigest = vi.fn().mockResolvedValue(mockHash.buffer);

      // Mock crypto.subtle
      Object.defineProperty(globalThis.crypto, 'subtle', {
        configurable: true,
        value: { digest: mockDigest },
        writable: true,
      });

      const result = await generateContentHash('test content');

      expect(mockDigest).toHaveBeenCalledWith('SHA-256', expect.any(Uint8Array));
      expect(result).toBe('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it('rejects an invalid SHA-256 digest length', async () => {
      const mockDigest = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4]).buffer);

      Object.defineProperty(globalThis.crypto, 'subtle', {
        configurable: true,
        value: { digest: mockDigest },
        writable: true,
      });

      await expect(generateContentHash('test content')).rejects.toThrowError(
        'SHA-256 returned an invalid 4-byte digest.'
      );
    });

    it('rejects when crypto.subtle is not available', async () => {
      // Remove crypto.subtle
      Object.defineProperty(globalThis.crypto, 'subtle', {
        configurable: true,
        value: undefined,
        writable: true,
      });

      await expect(generateContentHash('test content')).rejects.toThrowError(
        'Content hashing requires crypto.subtle.digest.'
      );
    });

    it('propagates crypto.subtle.digest failures', async () => {
      const digestError = new Error('crypto.subtle error');
      const mockDigest = vi.fn().mockRejectedValue(digestError);

      // Mock crypto.subtle with failing digest
      Object.defineProperty(globalThis.crypto, 'subtle', {
        configurable: true,
        value: { digest: mockDigest },
        writable: true,
      });

      await expect(generateContentHash('test content')).rejects.toBe(digestError);
    });

    it('generates consistent hashes for the same content', async () => {
      const content = 'test content for hashing';
      const hash1 = await generateContentHash(content);
      const hash2 = await generateContentHash(content);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
    });

    it('generates different hashes for different content', async () => {
      const hash1 = await generateContentHash('content 1');
      const hash2 = await generateContentHash('content 2');

      expect(hash1).not.toBe(hash2);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
      expect(hash2).toMatch(/^[0-9a-f]{64}$/);
    });

    it('handles empty content', async () => {
      const result = await generateContentHash('');

      expect(result).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('handles large content', async () => {
      const largeContent = 'a'.repeat(10_000);
      const result = await generateContentHash(largeContent);

      expect(result).toMatch(/^[0-9a-f]{64}$/);
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

  describe('sha256Hex and sha256Bytes', () => {
    const inputs: (string | Uint8Array)[] = [
      '',
      'héllo wörld ✓ 𝄞',
      '\ud800 lone surrogate',
      'x'.repeat(100_000),
      new Uint8Array([0, 1, 2, 255]),
    ];

    /** The module as a runtime without Node's builtins loads it, which hashes with @noble/hashes. */
    async function withoutNodeBuiltins(): Promise<typeof import('../crypto.js')> {
      vi.resetModules();
      const original = process.getBuiltinModule;
      Object.defineProperty(process, 'getBuiltinModule', { configurable: true, value: undefined });
      try {
        return await import('../crypto.js');
      } finally {
        Object.defineProperty(process, 'getBuiltinModule', { configurable: true, value: original });
      }
    }

    it("hash synchronously exactly as Node's crypto does, with and without Node", async () => {
      const portable = await withoutNodeBuiltins();
      for (const input of inputs) {
        const expected = createHash('sha256').update(input).digest('hex');
        expect(sha256Hex(input)).toBe(expected);
        expect(Buffer.from(sha256Bytes(input)).toString('hex')).toBe(expected);
        expect(portable.sha256Hex(input)).toBe(expected);
        expect(Buffer.from(portable.sha256Bytes(input)).toString('hex')).toBe(expected);
      }
    });
  });
});
