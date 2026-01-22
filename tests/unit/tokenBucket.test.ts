/**
 * Token Bucket Algorithm Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  calculateRefillTokens,
  refillBucket,
  createBucket,
  consumeTokens,
  calculateRetryAfterMs,
  ruleToConfig,
  calculateDefaultTtl,
  isBucketExpired,
  TokenBucketConfig,
} from '../../src/core/tokenBucket.js';
import { TokenBucketState, RateLimitRule } from '../../src/core/types.js';

describe('Token Bucket Algorithm', () => {
  const defaultConfig: TokenBucketConfig = {
    capacity: 10,
    refillTokens: 5,
    refillIntervalMs: 1000, // 5 tokens per second
  };

  describe('calculateRefillTokens', () => {
    it('should return 0 for 0 elapsed time', () => {
      expect(calculateRefillTokens(0, defaultConfig)).toBe(0);
    });

    it('should return 0 for negative elapsed time', () => {
      expect(calculateRefillTokens(-100, defaultConfig)).toBe(0);
    });

    it('should calculate correct tokens for one interval', () => {
      expect(calculateRefillTokens(1000, defaultConfig)).toBe(5);
    });

    it('should calculate correct tokens for multiple intervals', () => {
      expect(calculateRefillTokens(2000, defaultConfig)).toBe(10);
    });

    it('should calculate fractional tokens for partial intervals', () => {
      expect(calculateRefillTokens(500, defaultConfig)).toBe(2.5);
    });

    it('should handle very small intervals', () => {
      expect(calculateRefillTokens(100, defaultConfig)).toBe(0.5);
    });
  });

  describe('createBucket', () => {
    it('should create bucket with full capacity', () => {
      const now = Date.now();
      const bucket = createBucket(defaultConfig, now, 5000);

      expect(bucket.tokens).toBe(10);
      expect(bucket.lastRefillTime).toBe(now);
      expect(bucket.createdAt).toBe(now);
      expect(bucket.expiresAt).toBe(now + 5000);
    });
  });

  describe('refillBucket', () => {
    let initialState: TokenBucketState;
    const now = 1000000;

    beforeEach(() => {
      initialState = {
        tokens: 3,
        lastRefillTime: now,
        createdAt: now - 1000,
        expiresAt: now + 5000,
      };
    });

    it('should not refill if no time has passed', () => {
      const result = refillBucket(initialState, defaultConfig, now);
      expect(result.tokens).toBe(3);
    });

    it('should refill based on elapsed time', () => {
      const result = refillBucket(initialState, defaultConfig, now + 1000);
      expect(result.tokens).toBe(8); // 3 + 5
    });

    it('should cap tokens at capacity', () => {
      const result = refillBucket(initialState, defaultConfig, now + 5000);
      // Would be 3 + 25 = 28, but capped at 10
      expect(result.tokens).toBe(10);
    });

    it('should update lastRefillTime', () => {
      const result = refillBucket(initialState, defaultConfig, now + 1000);
      expect(result.lastRefillTime).toBe(now + 1000);
    });

    it('should not change state if time went backwards', () => {
      const result = refillBucket(initialState, defaultConfig, now - 100);
      expect(result.tokens).toBe(3);
      expect(result.lastRefillTime).toBe(now);
    });
  });

  describe('consumeTokens', () => {
    const now = 1000000;
    const ttlMs = 5000;

    it('should consume tokens when available', () => {
      const state: TokenBucketState = {
        tokens: 5,
        lastRefillTime: now,
        createdAt: now - 1000,
        expiresAt: now + 5000,
      };

      const result = consumeTokens(state, defaultConfig, 1, now, ttlMs);

      expect(result.allowed).toBe(true);
      expect(result.remainingTokens).toBe(4);
      expect(result.retryAfterMs).toBe(0);
      expect(result.bucketState.tokens).toBe(4);
    });

    it('should consume multiple tokens', () => {
      const state: TokenBucketState = {
        tokens: 5,
        lastRefillTime: now,
        createdAt: now - 1000,
        expiresAt: now + 5000,
      };

      const result = consumeTokens(state, defaultConfig, 3, now, ttlMs);

      expect(result.allowed).toBe(true);
      expect(result.remainingTokens).toBe(2);
    });

    it('should deny when not enough tokens', () => {
      const state: TokenBucketState = {
        tokens: 2,
        lastRefillTime: now,
        createdAt: now - 1000,
        expiresAt: now + 5000,
      };

      const result = consumeTokens(state, defaultConfig, 5, now, ttlMs);

      expect(result.allowed).toBe(false);
      expect(result.remainingTokens).toBe(2);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });

    it('should refill before checking', () => {
      const state: TokenBucketState = {
        tokens: 2,
        lastRefillTime: now - 1000, // 1 second ago
        createdAt: now - 2000,
        expiresAt: now + 5000,
      };

      // After 1 second, should have 2 + 5 = 7 tokens
      const result = consumeTokens(state, defaultConfig, 5, now, ttlMs);

      expect(result.allowed).toBe(true);
      expect(result.remainingTokens).toBe(2); // 7 - 5 = 2
    });

    it('should update expiry time on consumption', () => {
      const state: TokenBucketState = {
        tokens: 5,
        lastRefillTime: now,
        createdAt: now - 1000,
        expiresAt: now + 1000,
      };

      const result = consumeTokens(state, defaultConfig, 1, now, ttlMs);

      expect(result.bucketState.expiresAt).toBe(now + ttlMs);
    });

    it('should consume exactly capacity tokens on burst', () => {
      const state = createBucket(defaultConfig, now, ttlMs);

      // Consume all 10 tokens
      let currentState = state;
      for (let i = 0; i < 10; i++) {
        const result = consumeTokens(currentState, defaultConfig, 1, now, ttlMs);
        expect(result.allowed).toBe(true);
        currentState = result.bucketState;
      }

      // 11th should fail
      const result = consumeTokens(currentState, defaultConfig, 1, now, ttlMs);
      expect(result.allowed).toBe(false);
    });
  });

  describe('calculateRetryAfterMs', () => {
    it('should return 0 when no tokens needed', () => {
      expect(calculateRetryAfterMs(0, defaultConfig)).toBe(0);
    });

    it('should return 0 for negative tokens needed', () => {
      expect(calculateRetryAfterMs(-5, defaultConfig)).toBe(0);
    });

    it('should calculate correct wait time for 1 token', () => {
      // Need 1 token, refill rate is 5 per 1000ms
      // 1 / 5 * 1000 = 200ms
      expect(calculateRetryAfterMs(1, defaultConfig)).toBe(200);
    });

    it('should calculate correct wait time for multiple tokens', () => {
      // Need 5 tokens = 1 full interval = 1000ms
      expect(calculateRetryAfterMs(5, defaultConfig)).toBe(1000);
    });

    it('should round up to whole milliseconds', () => {
      // Need 3 tokens = 3/5 * 1000 = 600ms
      expect(calculateRetryAfterMs(3, defaultConfig)).toBe(600);

      // Need 7 tokens = 7/5 * 1000 = 1400ms
      expect(calculateRetryAfterMs(7, defaultConfig)).toBe(1400);
    });

    it('should handle zero refill rate', () => {
      const noRefill: TokenBucketConfig = {
        ...defaultConfig,
        refillTokens: 0,
      };
      expect(calculateRetryAfterMs(1, noRefill)).toBe(Number.MAX_SAFE_INTEGER);
    });
  });

  describe('ruleToConfig', () => {
    it('should extract config from rule', () => {
      const rule: RateLimitRule = {
        name: 'test',
        key: ['ip'],
        capacity: 20,
        refillTokens: 10,
        refillIntervalMs: 60000,
      };

      const config = ruleToConfig(rule);

      expect(config.capacity).toBe(20);
      expect(config.refillTokens).toBe(10);
      expect(config.refillIntervalMs).toBe(60000);
    });
  });

  describe('calculateDefaultTtl', () => {
    it('should return specified ttlMs if present', () => {
      const rule: RateLimitRule = {
        name: 'test',
        key: ['ip'],
        capacity: 10,
        refillTokens: 5,
        refillIntervalMs: 1000,
        ttlMs: 30000,
      };

      expect(calculateDefaultTtl(rule)).toBe(30000);
    });

    it('should calculate 2x full refill time if not specified', () => {
      const rule: RateLimitRule = {
        name: 'test',
        key: ['ip'],
        capacity: 10,
        refillTokens: 5,
        refillIntervalMs: 1000,
        // No ttlMs
      };

      // Full refill = (10/5) * 1000 = 2000ms
      // Default TTL = 2 * 2000 = 4000ms
      expect(calculateDefaultTtl(rule)).toBe(4000);
    });
  });

  describe('isBucketExpired', () => {
    it('should return true when current time >= expiresAt', () => {
      const state: TokenBucketState = {
        tokens: 5,
        lastRefillTime: 1000,
        createdAt: 1000,
        expiresAt: 2000,
      };

      expect(isBucketExpired(state, 2000)).toBe(true);
      expect(isBucketExpired(state, 2001)).toBe(true);
    });

    it('should return false when current time < expiresAt', () => {
      const state: TokenBucketState = {
        tokens: 5,
        lastRefillTime: 1000,
        createdAt: 1000,
        expiresAt: 2000,
      };

      expect(isBucketExpired(state, 1999)).toBe(false);
      expect(isBucketExpired(state, 1000)).toBe(false);
    });
  });
});
