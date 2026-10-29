import { describe, expect, it } from 'vitest';
import { stableHash } from '../hash-utils.js';

describe('hash-utils', () => {
  describe('stableHash', () => {
    it('generates consistent hashes for the same input', () => {
      const input = 'test/path/to/directory';
      expect(stableHash(input)).toBe(stableHash(input));
    });

    it('generates different hashes for different inputs', () => {
      const input1 = 'test/path/to/directory1';
      const input2 = 'test/path/to/directory2';
      expect(stableHash(input1)).not.toBe(stableHash(input2));
    });

    it('always starts with "h"', () => {
      const inputs = ['test', 'very/long/path/to/somewhere', '!@#$special%^&*chars', ''];

      for (const input of inputs) {
        expect(stableHash(input)).toMatch(/^h[a-z0-9]+$/u);
      }
    });

    it('handles empty strings', () => {
      expect(stableHash('')).toBe(stableHash(''));
    });

    it('handles special characters', () => {
      const input = '!@#$%^&*()_+-=[]{}|;:,.<>?';
      expect(stableHash(input)).toBe(stableHash(input));
    });

    it('generates reasonable length hashes', () => {
      const longInput = 'a'.repeat(1000);
      const hash = stableHash(longInput);
      expect(hash.length).toBeLessThan(20); // Should be much shorter than input
    });

    // NEW: Tests that verify specific hash outputs to catch algorithm mutations
    it('generates expected hashes for known inputs', () => {
      // These specific values help catch mutations in the hash algorithm
      expect(stableHash('a')).toBe('h2p'); // Single character
      expect(stableHash('test')).toBe('h2487m'); // Common test string
      expect(stableHash('hello')).toBe('h1n1e4y'); // Another common string
      expect(stableHash('12345')).toBe('hruxir'); // Numeric string
    });

    it('demonstrates hash algorithm sensitivity to input changes', () => {
      // Small changes should produce different hashes
      expect(stableHash('test')).not.toBe(stableHash('Test')); // Case change
      expect(stableHash('test')).not.toBe(stableHash('test ')); // Trailing space
      expect(stableHash('test')).not.toBe(stableHash('tes')); // Missing character
      expect(stableHash('test')).not.toBe(stableHash('testa')); // Extra character
    });

    it('verifies hash distribution for similar inputs', () => {
      // Test that similar inputs produce distinctly different hashes
      const baseInput = 'file';
      const variations = [
        `${baseInput}1`,
        `${baseInput}2`,
        `${baseInput}3`,
        `${baseInput}a`,
        `${baseInput}b`,
        `${baseInput}_`,
      ];

      const hashes = variations.map((input) => stableHash(input));

      // All hashes should be different
      const uniqueHashes = new Set(hashes);
      expect(uniqueHashes.size).toBe(hashes.length);

      // Hashes should have reasonable length
      for (const hash of hashes) {
        expect(hash.length).toBeGreaterThan(2);
        expect(hash).toMatch(/^h[a-z0-9]+$/u);
      }
    });

    it('produces stable hashes across multiple calls', () => {
      // Run the same input through multiple calls to ensure consistency
      const input = 'consistency/test/path';
      const firstHash = stableHash(input);

      // Call multiple times
      for (let i = 0; i < 10; i++) {
        expect(stableHash(input)).toBe(firstHash);
      }
    });

    it('handles unicode characters correctly', () => {
      const unicodeInputs = ['café', '你好', '🚀', 'émoji🎉test'];

      for (const input of unicodeInputs) {
        const hash = stableHash(input);
        expect(hash).toMatch(/^h[a-z0-9]+$/u);
        expect(stableHash(input)).toBe(hash); // Consistency check
      }
    });

    it('verifies hash algorithm arithmetic operations', () => {
      // These tests are designed to catch specific mutations in the hash algorithm
      // By testing inputs that would behave differently if arithmetic operations were changed

      // Test with inputs that would expose bit shift mutations (<<5 vs other shifts)
      const testA = stableHash('A');
      const testB = stableHash('B');
      const testC = stableHash('C');

      // All should be different (catching arithmetic operation mutations)
      expect(testA).not.toBe(testB);
      expect(testB).not.toBe(testC);
      expect(testA).not.toBe(testC);

      // Test specific patterns that would expose +/- mutations in hash calculation
      expect(stableHash('x')).not.toBe(stableHash('y'));
      expect(stableHash('0')).not.toBe(stableHash('1'));
    });

    it('detects changes in bit operations', () => {
      // Test patterns that would expose &= vs |= mutations
      const patterns = ['bit1', 'bit2', 'bit3', 'bit4'];
      const hashes = patterns.map((p) => stableHash(p));

      // All should be unique, helping detect bit operation mutations
      const uniqueHashes = new Set(hashes);
      expect(uniqueHashes.size).toBe(patterns.length);

      // Test that the hash contains expected characteristics from bit operations
      for (const hash of hashes) {
        expect(hash).toMatch(/^h[a-z0-9]+$/u);
        expect(hash.length).toBeGreaterThan(1);
      }
    });
  });
});
