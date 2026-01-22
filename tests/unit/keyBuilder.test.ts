/**
 * Key Builder Tests
 */

import { describe, it, expect } from 'vitest';
import {
  DefaultKeyExtractor,
  buildKey,
  buildKeysForRules,
  parseKey,
  extractDimensionsForLogging,
  validateDimensions,
} from '../../src/core/keyBuilder.js';
import { KeyDimension, RateLimitRule, RequestContext } from '../../src/core/types.js';

describe('Key Builder', () => {
  describe('DefaultKeyExtractor', () => {
    const extractor = new DefaultKeyExtractor();

    it('should extract ip dimension', () => {
      const context: RequestContext = { action: 'test', ip: '192.168.1.1' };
      expect(extractor.extract('ip', context)).toBe('192.168.1.1');
    });

    it('should extract emailHash dimension', () => {
      const context: RequestContext = { action: 'test', emailHash: 'abc123' };
      expect(extractor.extract('emailHash', context)).toBe('abc123');
    });

    it('should extract action dimension', () => {
      const context: RequestContext = { action: 'password_reset' };
      expect(extractor.extract('action', context)).toBe('password_reset');
    });

    it('should return undefined for missing dimensions', () => {
      const context: RequestContext = { action: 'test' };
      expect(extractor.extract('ip', context)).toBeUndefined();
    });

    it('should extract custom dimensions from context', () => {
      const context: RequestContext = { action: 'test', customField: 'value' };
      // Testing custom dimension extraction (not a standard KeyDimension)
      expect(extractor.extract('customField' as KeyDimension, context)).toBe('value');
    });
  });

  describe('buildKey', () => {
    const rule: RateLimitRule = {
      name: 'per_ip',
      key: ['ip'],
      capacity: 10,
      refillTokens: 5,
      refillIntervalMs: 1000,
    };

    it('should build key for single dimension', () => {
      const context: RequestContext = { action: 'test', ip: '192.168.1.1' };
      const key = buildKey('test_action', rule, context);
      expect(key).toBe('test_action:per_ip:ip=192.168.1.1');
    });

    it('should build key for multiple dimensions', () => {
      const multiRule: RateLimitRule = {
        ...rule,
        name: 'per_ip_email',
        key: ['ip', 'emailHash'],
      };
      const context: RequestContext = {
        action: 'test',
        ip: '192.168.1.1',
        emailHash: 'abc123',
      };
      const key = buildKey('test_action', multiRule, context);
      expect(key).toBe('test_action:per_ip_email:ip=192.168.1.1:emailHash=abc123');
    });

    it('should return undefined when dimension is missing', () => {
      const context: RequestContext = { action: 'test' };
      const key = buildKey('test_action', rule, context);
      expect(key).toBeUndefined();
    });

    it('should return undefined when dimension is empty string', () => {
      const context: RequestContext = { action: 'test', ip: '' };
      const key = buildKey('test_action', rule, context);
      expect(key).toBeUndefined();
    });

    it('should sanitize values with colons', () => {
      const context: RequestContext = { action: 'test', ip: '::1' };
      const key = buildKey('test_action', rule, context);
      expect(key).toBe('test_action:per_ip:ip=__1');
    });

    it('should sanitize values with equals signs', () => {
      const context: RequestContext = { action: 'test', ip: 'key=value' };
      const key = buildKey('test_action', rule, context);
      expect(key).toBe('test_action:per_ip:ip=key_value');
    });
  });

  describe('buildKeysForRules', () => {
    const rules: RateLimitRule[] = [
      {
        name: 'per_ip',
        key: ['ip'],
        capacity: 10,
        refillTokens: 5,
        refillIntervalMs: 1000,
      },
      {
        name: 'per_email',
        key: ['emailHash'],
        capacity: 5,
        refillTokens: 3,
        refillIntervalMs: 60000,
      },
    ];

    it('should build keys for all rules', () => {
      const context: RequestContext = {
        action: 'test',
        ip: '192.168.1.1',
        emailHash: 'abc123',
      };

      const keys = buildKeysForRules('test_action', rules, context);

      expect(keys.size).toBe(2);
      expect(keys.get('per_ip')).toBe('test_action:per_ip:ip=192.168.1.1');
      expect(keys.get('per_email')).toBe('test_action:per_email:emailHash=abc123');
    });

    it('should set undefined for rules with missing dimensions', () => {
      const context: RequestContext = {
        action: 'test',
        ip: '192.168.1.1',
        // no emailHash
      };

      const keys = buildKeysForRules('test_action', rules, context);

      expect(keys.get('per_ip')).toBeDefined();
      expect(keys.get('per_email')).toBeUndefined();
    });
  });

  describe('parseKey', () => {
    it('should parse simple key', () => {
      const result = parseKey('action:ruleName:ip=192.168.1.1');
      expect(result).toEqual({
        action: 'action',
        ruleName: 'ruleName',
        dimensions: { ip: '192.168.1.1' },
      });
    });

    it('should parse key with multiple dimensions', () => {
      const result = parseKey('action:ruleName:ip=192.168.1.1:emailHash=abc123');
      expect(result).toEqual({
        action: 'action',
        ruleName: 'ruleName',
        dimensions: { ip: '192.168.1.1', emailHash: 'abc123' },
      });
    });

    it('should return null for invalid key', () => {
      expect(parseKey('invalid')).toBeNull();
      expect(parseKey('')).toBeNull();
    });

    it('should handle empty dimensions', () => {
      const result = parseKey('action:ruleName');
      expect(result).toEqual({
        action: 'action',
        ruleName: 'ruleName',
        dimensions: {},
      });
    });
  });

  describe('extractDimensionsForLogging', () => {
    it('should extract requested dimensions', () => {
      const context: RequestContext = {
        action: 'test',
        ip: '192.168.1.1',
        emailHash: 'abc123def456',
        sessionId: 'sess-123',
      };

      const result = extractDimensionsForLogging(context, ['ip', 'sessionId']);

      expect(result).toEqual({
        ip: '192.168.1.1',
        sessionId: 'sess-123',
      });
    });

    it('should mask hash values', () => {
      const context: RequestContext = {
        action: 'test',
        emailHash: 'abc123def456789012345',
        phoneHash: 'xyz789abc123456789012',
      };

      const result = extractDimensionsForLogging(context, ['emailHash', 'phoneHash']);

      expect(result.emailHash).toBe('abc123de...');
      expect(result.phoneHash).toBe('xyz789ab...');
    });

    it('should skip missing dimensions', () => {
      const context: RequestContext = { action: 'test', ip: '192.168.1.1' };
      const result = extractDimensionsForLogging(context, ['ip', 'emailHash']);

      expect(result).toEqual({ ip: '192.168.1.1' });
    });
  });

  describe('validateDimensions', () => {
    it('should return empty array when all dimensions present', () => {
      const context: RequestContext = {
        action: 'test',
        ip: '192.168.1.1',
        emailHash: 'abc123',
      };

      const missing = validateDimensions(context, ['ip', 'emailHash']);

      expect(missing).toEqual([]);
    });

    it('should return missing dimensions', () => {
      const context: RequestContext = { action: 'test', ip: '192.168.1.1' };

      const missing = validateDimensions(context, ['ip', 'emailHash', 'sessionId']);

      expect(missing).toEqual(['emailHash', 'sessionId']);
    });

    it('should treat empty strings as missing', () => {
      const context: RequestContext = { action: 'test', ip: '' };

      const missing = validateDimensions(context, ['ip']);

      expect(missing).toEqual(['ip']);
    });
  });
});
