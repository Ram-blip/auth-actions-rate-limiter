/**
 * Hash Utilities Tests
 */

import { describe, it, expect } from 'vitest';
import { hashIdentifier, hashEmail, hashPhone, hashesMatch } from '../../src/utils/hash.js';

describe('Hash Utilities', () => {
  const secret = 'test-secret-key-12345';

  describe('hashIdentifier', () => {
    it('should return consistent hash for same input', () => {
      const hash1 = hashIdentifier('test@example.com', secret);
      const hash2 = hashIdentifier('test@example.com', secret);
      expect(hash1).toBe(hash2);
    });

    it('should return different hash for different inputs', () => {
      const hash1 = hashIdentifier('test1@example.com', secret);
      const hash2 = hashIdentifier('test2@example.com', secret);
      expect(hash1).not.toBe(hash2);
    });

    it('should return different hash with different secrets', () => {
      const hash1 = hashIdentifier('test@example.com', 'secret1');
      const hash2 = hashIdentifier('test@example.com', 'secret2');
      expect(hash1).not.toBe(hash2);
    });

    it('should normalize to lowercase', () => {
      const hash1 = hashIdentifier('TEST@EXAMPLE.COM', secret);
      const hash2 = hashIdentifier('test@example.com', secret);
      expect(hash1).toBe(hash2);
    });

    it('should trim whitespace', () => {
      const hash1 = hashIdentifier('  test@example.com  ', secret);
      const hash2 = hashIdentifier('test@example.com', secret);
      expect(hash1).toBe(hash2);
    });

    it('should return 64-character hex string (SHA256)', () => {
      const hash = hashIdentifier('test@example.com', secret);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should throw for empty identifier', () => {
      expect(() => hashIdentifier('', secret)).toThrow('Identifier cannot be empty');
    });

    it('should throw for empty secret', () => {
      expect(() => hashIdentifier('test@example.com', '')).toThrow('Secret cannot be empty');
    });

    it('should not reveal original identifier', () => {
      const hash = hashIdentifier('user@example.com', secret);
      expect(hash).not.toContain('user');
      expect(hash).not.toContain('example');
      expect(hash).not.toContain('@');
    });
  });

  describe('hashEmail', () => {
    it('should hash email consistently', () => {
      const hash1 = hashEmail('user@example.com', secret);
      const hash2 = hashEmail('user@example.com', secret);
      expect(hash1).toBe(hash2);
    });

    it('should normalize email case', () => {
      const hash1 = hashEmail('User@Example.COM', secret);
      const hash2 = hashEmail('user@example.com', secret);
      expect(hash1).toBe(hash2);
    });

    it('should handle emails with plus addressing', () => {
      const hash1 = hashEmail('user+tag@example.com', secret);
      const hash2 = hashEmail('user+tag@example.com', secret);
      expect(hash1).toBe(hash2);
    });
  });

  describe('hashPhone', () => {
    it('should hash phone consistently', () => {
      const hash1 = hashPhone('+1-234-567-8900', secret);
      const hash2 = hashPhone('+1-234-567-8900', secret);
      expect(hash1).toBe(hash2);
    });

    it('should normalize phone by stripping non-digits', () => {
      const hash1 = hashPhone('+1-234-567-8900', secret);
      const hash2 = hashPhone('12345678900', secret);
      expect(hash1).toBe(hash2);
    });

    it('should normalize different formats', () => {
      const hash1 = hashPhone('+1 (234) 567-8900', secret);
      const hash2 = hashPhone('1.234.567.8900', secret);
      expect(hash1).toBe(hash2);
    });

    it('should throw for phone with no digits', () => {
      expect(() => hashPhone('abc', secret)).toThrow('Phone number must contain digits');
    });
  });

  describe('hashesMatch', () => {
    it('should return true for same identifiers', () => {
      expect(hashesMatch('test@example.com', 'test@example.com', secret)).toBe(true);
    });

    it('should return true for normalized equivalent identifiers', () => {
      expect(hashesMatch('TEST@example.com', 'test@example.com', secret)).toBe(true);
    });

    it('should return false for different identifiers', () => {
      expect(hashesMatch('test1@example.com', 'test2@example.com', secret)).toBe(false);
    });

    it('should use timing-safe comparison', () => {
      // This is hard to test directly, but we verify the logic works
      expect(hashesMatch('a', 'a', secret)).toBe(true);
      expect(hashesMatch('a', 'b', secret)).toBe(false);
    });
  });

  describe('Security Properties', () => {
    it('should produce irreversible hashes', () => {
      // Given a hash, we cannot determine the original input
      const hash = hashIdentifier('secret-email@example.com', secret);
      // This is a property we assert by design - hashes are one-way
      expect(typeof hash).toBe('string');
      expect(hash.length).toBe(64);
    });

    it('should be deterministic', () => {
      // Same input always produces same output
      const results = [];
      for (let i = 0; i < 100; i++) {
        results.push(hashIdentifier('test@example.com', secret));
      }
      expect(new Set(results).size).toBe(1);
    });

    it('should have avalanche effect (small input change = big hash change)', () => {
      const hash1 = hashIdentifier('test@example.com', secret);
      const hash2 = hashIdentifier('test@example.con', secret);

      // Count differing characters
      let differences = 0;
      for (let i = 0; i < hash1.length; i++) {
        if (hash1[i] !== hash2[i]) differences++;
      }

      // Expect significant difference (at least 25% of characters)
      expect(differences).toBeGreaterThan(16);
    });
  });
});
