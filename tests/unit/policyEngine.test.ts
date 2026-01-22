/**
 * Policy Engine Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PolicyEngine } from '../../src/core/policyEngine.js';
import { MemoryStore } from '../../src/stores/memoryStore.js';
import { ActionPolicy, RequestContext, RateLimitStore } from '../../src/core/types.js';

describe('PolicyEngine', () => {
  let store: MemoryStore;
  let currentTime: number;

  // Use a fixed base time for all tests
  const BASE_TIME = 1_000_000_000;

  beforeEach(() => {
    // Set system time to a known value
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BASE_TIME));
    currentTime = BASE_TIME;

    store = new MemoryStore({ sweepIntervalMs: 60_000 });
  });

  afterEach(async () => {
    await store.shutdown();
    vi.useRealTimers();
  });

  // Helper to advance time consistently
  const advanceTime = (ms: number) => {
    currentTime += ms;
    vi.setSystemTime(new Date(currentTime));
  };

  const simplePolicy: ActionPolicy = {
    id: 'test_action',
    rules: [
      {
        name: 'per_ip',
        key: ['ip'],
        capacity: 5,
        refillTokens: 5,
        refillIntervalMs: 60_000, // 5 per minute
        cost: 1,
        mode: 'block',
      },
    ],
    failMode: 'closed',
  };

  describe('Basic Rate Limiting', () => {
    it('should allow requests within limit', async () => {
      const engine = new PolicyEngine({
        store,
        policies: { test_action: simplePolicy },
        timeProvider: () => currentTime,
      });

      const context: RequestContext = { action: 'test_action', ip: '192.168.1.1' };

      // First 5 requests should be allowed
      for (let i = 0; i < 5; i++) {
        const decision = await engine.check(context);
        expect(decision.allowed).toBe(true);
        expect(decision.outcome).toBe('ALLOWED');
      }
    });

    it('should block requests exceeding limit', async () => {
      const engine = new PolicyEngine({
        store,
        policies: { test_action: simplePolicy },
        timeProvider: () => currentTime,
      });

      const context: RequestContext = { action: 'test_action', ip: '192.168.1.1' };

      // Exhaust the limit
      for (let i = 0; i < 5; i++) {
        await engine.check(context);
      }

      // 6th request should be blocked
      const decision = await engine.check(context);
      expect(decision.allowed).toBe(false);
      expect(decision.outcome).toBe('BLOCKED');
      expect(decision.retryAfterMs).toBeGreaterThan(0);
    });

    it('should calculate correct retryAfterMs', async () => {
      const engine = new PolicyEngine({
        store,
        policies: { test_action: simplePolicy },
        timeProvider: () => currentTime,
      });

      const context: RequestContext = { action: 'test_action', ip: '192.168.1.1' };

      // Exhaust the limit
      for (let i = 0; i < 5; i++) {
        await engine.check(context);
      }

      const decision = await engine.check(context);
      // Need 1 token, refill rate is 5 per 60000ms = 12000ms per token
      expect(decision.retryAfterMs).toBe(12000);
    });

    it('should allow requests after refill time', async () => {
      const engine = new PolicyEngine({
        store,
        policies: { test_action: simplePolicy },
        timeProvider: () => currentTime,
      });

      const context: RequestContext = { action: 'test_action', ip: '192.168.1.1' };

      // Exhaust the limit
      for (let i = 0; i < 5; i++) {
        await engine.check(context);
      }

      // Should be blocked
      let decision = await engine.check(context);
      expect(decision.allowed).toBe(false);

      // Advance time to refill all tokens
      advanceTime(60_000);

      // Should be allowed again
      decision = await engine.check(context);
      expect(decision.allowed).toBe(true);
    });
  });

  describe('AND Semantics', () => {
    const multiRulePolicy: ActionPolicy = {
      id: 'multi_rule',
      rules: [
        {
          name: 'per_ip',
          key: ['ip'],
          capacity: 10,
          refillTokens: 10,
          refillIntervalMs: 60_000,
        },
        {
          name: 'per_email',
          key: ['emailHash'],
          capacity: 3,
          refillTokens: 3,
          refillIntervalMs: 60_000,
        },
      ],
      failMode: 'closed',
    };

    it('should allow only if ALL rules pass', async () => {
      const engine = new PolicyEngine({
        store,
        policies: { multi_rule: multiRulePolicy },
        timeProvider: () => currentTime,
      });

      const context: RequestContext = {
        action: 'multi_rule',
        ip: '192.168.1.1',
        emailHash: 'hash123',
      };

      // First 3 requests should pass (limited by email rule)
      for (let i = 0; i < 3; i++) {
        const decision = await engine.check(context);
        expect(decision.allowed).toBe(true);
      }

      // 4th request should be blocked (email rule exhausted)
      const decision = await engine.check(context);
      expect(decision.allowed).toBe(false);
    });

    it('should block if ANY rule fails', async () => {
      const engine = new PolicyEngine({
        store,
        policies: { multi_rule: multiRulePolicy },
        timeProvider: () => currentTime,
      });

      // Use different emails but same IP
      for (let i = 0; i < 10; i++) {
        const context: RequestContext = {
          action: 'multi_rule',
          ip: '192.168.1.1',
          emailHash: `hash${i}`,
        };
        await engine.check(context);
      }

      // 11th request (different email, same IP) should be blocked
      const context: RequestContext = {
        action: 'multi_rule',
        ip: '192.168.1.1',
        emailHash: 'newhash',
      };
      const decision = await engine.check(context);
      expect(decision.allowed).toBe(false);
    });

    it('should report all rule results', async () => {
      const engine = new PolicyEngine({
        store,
        policies: { multi_rule: multiRulePolicy },
        timeProvider: () => currentTime,
      });

      const context: RequestContext = {
        action: 'multi_rule',
        ip: '192.168.1.1',
        emailHash: 'hash123',
      };

      const decision = await engine.check(context);

      expect(decision.ruleResults).toHaveLength(2);
      expect(decision.ruleResults[0]?.ruleName).toBe('per_ip');
      expect(decision.ruleResults[1]?.ruleName).toBe('per_email');
    });
  });

  describe('Challenge Mode', () => {
    const challengePolicy: ActionPolicy = {
      id: 'challenge_action',
      rules: [
        {
          name: 'per_ip',
          key: ['ip'],
          capacity: 3,
          refillTokens: 3,
          refillIntervalMs: 60_000,
          mode: 'challenge',
        },
      ],
      failMode: 'closed',
    };

    it('should return CHALLENGE outcome when limit exceeded', async () => {
      const engine = new PolicyEngine({
        store,
        policies: { challenge_action: challengePolicy },
        timeProvider: () => currentTime,
      });

      const context: RequestContext = { action: 'challenge_action', ip: '192.168.1.1' };

      // Exhaust the limit
      for (let i = 0; i < 3; i++) {
        await engine.check(context);
      }

      const decision = await engine.check(context);
      expect(decision.outcome).toBe('CHALLENGE');
      expect(decision.allowed).toBe(true); // Challenge still allows the request
      expect(decision.challenge).toBe('captcha_required');
    });

    it('should allow through with CHALLENGE', async () => {
      const engine = new PolicyEngine({
        store,
        policies: { challenge_action: challengePolicy },
        timeProvider: () => currentTime,
      });

      const context: RequestContext = { action: 'challenge_action', ip: '192.168.1.1' };

      for (let i = 0; i < 3; i++) {
        await engine.check(context);
      }

      const decision = await engine.check(context);
      // Challenge mode allows through
      expect(decision.allowed).toBe(true);
    });
  });

  describe('Missing Dimensions', () => {
    it('should skip rules with missing dimensions', async () => {
      const engine = new PolicyEngine({
        store,
        policies: { test_action: simplePolicy },
        timeProvider: () => currentTime,
      });

      // Context without IP (required for the rule)
      const context: RequestContext = { action: 'test_action' };

      const decision = await engine.check(context);

      // Should be allowed because rule is skipped
      expect(decision.allowed).toBe(true);
      expect(decision.ruleResults[0]?.key).toBe('skipped');
    });
  });

  describe('No Matching Policy', () => {
    it('should allow requests for unknown actions', async () => {
      const engine = new PolicyEngine({
        store,
        policies: { test_action: simplePolicy },
        timeProvider: () => currentTime,
      });

      const context: RequestContext = { action: 'unknown_action', ip: '192.168.1.1' };

      const decision = await engine.check(context);

      expect(decision.allowed).toBe(true);
      expect(decision.outcome).toBe('ALLOWED');
      expect(decision.ruleResults).toHaveLength(0);
    });
  });

  describe('Fail Mode', () => {
    it('should fail closed when store throws', async () => {
      const failingStore: RateLimitStore = {
        get: async () => {
          throw new Error('Store error');
        },
        set: async () => {
          throw new Error('Store error');
        },
        delete: async () => {
          throw new Error('Store error');
        },
        has: async () => {
          throw new Error('Store error');
        },
        size: async () => 0,
        clear: async () => {},
        shutdown: async () => {},
      };

      const engine = new PolicyEngine({
        store: failingStore,
        policies: {
          test_action: { ...simplePolicy, failMode: 'closed' },
        },
      });

      const context: RequestContext = { action: 'test_action', ip: '192.168.1.1' };
      const decision = await engine.check(context);

      expect(decision.allowed).toBe(false);
      expect(decision.failedDueToError).toBe(true);
    });

    it('should fail open when store throws and failMode is open', async () => {
      const failingStore: RateLimitStore = {
        get: async () => {
          throw new Error('Store error');
        },
        set: async () => {
          throw new Error('Store error');
        },
        delete: async () => {
          throw new Error('Store error');
        },
        has: async () => {
          throw new Error('Store error');
        },
        size: async () => 0,
        clear: async () => {},
        shutdown: async () => {},
      };

      const engine = new PolicyEngine({
        store: failingStore,
        policies: {
          test_action: { ...simplePolicy, failMode: 'open' },
        },
      });

      const context: RequestContext = { action: 'test_action', ip: '192.168.1.1' };
      const decision = await engine.check(context);

      expect(decision.allowed).toBe(true);
      expect(decision.failedDueToError).toBe(true);
    });
  });

  describe('Cost', () => {
    const costPolicy: ActionPolicy = {
      id: 'cost_action',
      rules: [
        {
          name: 'per_ip',
          key: ['ip'],
          capacity: 10,
          refillTokens: 10,
          refillIntervalMs: 60_000,
          cost: 3, // Each request costs 3 tokens
        },
      ],
      failMode: 'closed',
    };

    it('should consume multiple tokens per request', async () => {
      const engine = new PolicyEngine({
        store,
        policies: { cost_action: costPolicy },
        timeProvider: () => currentTime,
      });

      const context: RequestContext = { action: 'cost_action', ip: '192.168.1.1' };

      // 10 capacity, 3 cost per request = 3 requests allowed
      for (let i = 0; i < 3; i++) {
        const decision = await engine.check(context);
        expect(decision.allowed).toBe(true);
      }

      // 4th request should be blocked (only 1 token left, need 3)
      const decision = await engine.check(context);
      expect(decision.allowed).toBe(false);
    });
  });

  describe('Concurrency', () => {
    it('should handle sequential requests correctly', async () => {
      const engine = new PolicyEngine({
        store,
        policies: { test_action: simplePolicy },
        timeProvider: () => currentTime,
      });

      const context: RequestContext = { action: 'test_action', ip: '192.168.1.1' };

      // Fire 10 sequential requests
      const results = [];
      for (let i = 0; i < 10; i++) {
        results.push(await engine.check(context));
      }

      // Exactly 5 should be allowed (capacity is 5)
      const allowedCount = results.filter((r) => r.allowed).length;
      expect(allowedCount).toBe(5);
    });

    it('should allow refill after time passes', async () => {
      const engine = new PolicyEngine({
        store,
        policies: { test_action: simplePolicy },
        timeProvider: () => currentTime,
      });

      const context: RequestContext = { action: 'test_action', ip: '192.168.1.1' };

      // First batch - exhaust tokens
      const batch1Results = [];
      for (let i = 0; i < 10; i++) {
        batch1Results.push(await engine.check(context));
      }
      const allowed1 = batch1Results.filter((r) => r.allowed).length;
      expect(allowed1).toBe(5);

      // Advance time for full refill
      advanceTime(60_000);

      // Second batch - should have 5 more tokens
      const batch2Results = [];
      for (let i = 0; i < 10; i++) {
        batch2Results.push(await engine.check(context));
      }
      const allowed2 = batch2Results.filter((r) => r.allowed).length;
      expect(allowed2).toBe(5);
    });
  });

  describe('Utility Methods', () => {
    it('should return policy by action ID', () => {
      const engine = new PolicyEngine({
        store,
        policies: { test_action: simplePolicy },
      });

      expect(engine.getPolicy('test_action')).toEqual(simplePolicy);
      expect(engine.getPolicy('unknown')).toBeUndefined();
    });

    it('should list all action IDs', () => {
      const engine = new PolicyEngine({
        store,
        policies: {
          action1: simplePolicy,
          action2: { ...simplePolicy, id: 'action2' },
        },
      });

      const actions = engine.listActions();
      expect(actions).toContain('action1');
      expect(actions).toContain('action2');
    });
  });
});
