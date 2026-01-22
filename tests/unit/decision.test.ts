/**
 * Decision Tests
 */

import { describe, it, expect } from 'vitest';
import {
  combineRuleResults,
  createErrorDecision,
  createMissingDimensionDecision,
  createAllowedDecision,
  createBlockedDecision,
  formatDecisionForLogging,
} from '../../src/core/decision.js';
import { RuleResult } from '../../src/core/types.js';

describe('Decision Logic', () => {
  describe('combineRuleResults', () => {
    it('should allow when no rules', () => {
      const decision = combineRuleResults('test', [], {});

      expect(decision.allowed).toBe(true);
      expect(decision.outcome).toBe('ALLOWED');
      expect(decision.retryAfterMs).toBe(0);
    });

    it('should allow when all rules pass', () => {
      const results: RuleResult[] = [
        {
          ruleName: 'rule1',
          key: 'key1',
          allowed: true,
          outcome: 'ALLOWED',
          retryAfterMs: 0,
          remainingTokens: 5,
        },
        {
          ruleName: 'rule2',
          key: 'key2',
          allowed: true,
          outcome: 'ALLOWED',
          retryAfterMs: 0,
          remainingTokens: 10,
        },
      ];

      const decision = combineRuleResults('test', results, {});

      expect(decision.allowed).toBe(true);
      expect(decision.outcome).toBe('ALLOWED');
      expect(decision.retryAfterMs).toBe(0);
    });

    it('should block when any rule blocks', () => {
      const results: RuleResult[] = [
        {
          ruleName: 'rule1',
          key: 'key1',
          allowed: true,
          outcome: 'ALLOWED',
          retryAfterMs: 0,
          remainingTokens: 5,
        },
        {
          ruleName: 'rule2',
          key: 'key2',
          allowed: false,
          outcome: 'BLOCKED',
          retryAfterMs: 30000,
          remainingTokens: 0,
        },
      ];

      const decision = combineRuleResults('test', results, {});

      expect(decision.allowed).toBe(false);
      expect(decision.outcome).toBe('BLOCKED');
      expect(decision.retryAfterMs).toBe(30000);
    });

    it('should use maximum retryAfterMs across blocked rules', () => {
      const results: RuleResult[] = [
        {
          ruleName: 'rule1',
          key: 'key1',
          allowed: false,
          outcome: 'BLOCKED',
          retryAfterMs: 10000,
          remainingTokens: 0,
        },
        {
          ruleName: 'rule2',
          key: 'key2',
          allowed: false,
          outcome: 'BLOCKED',
          retryAfterMs: 30000,
          remainingTokens: 0,
        },
        {
          ruleName: 'rule3',
          key: 'key3',
          allowed: false,
          outcome: 'BLOCKED',
          retryAfterMs: 20000,
          remainingTokens: 0,
        },
      ];

      const decision = combineRuleResults('test', results, {});

      expect(decision.retryAfterMs).toBe(30000);
    });

    it('should return CHALLENGE when no blocks but some challenges', () => {
      const results: RuleResult[] = [
        {
          ruleName: 'rule1',
          key: 'key1',
          allowed: true,
          outcome: 'ALLOWED',
          retryAfterMs: 0,
          remainingTokens: 5,
        },
        {
          ruleName: 'rule2',
          key: 'key2',
          allowed: true, // Challenge allows through
          outcome: 'CHALLENGE',
          retryAfterMs: 0,
          remainingTokens: 0,
          challenge: 'captcha_required',
        },
      ];

      const decision = combineRuleResults('test', results, {});

      expect(decision.allowed).toBe(true);
      expect(decision.outcome).toBe('CHALLENGE');
      expect(decision.challenge).toBe('captcha_required');
    });

    it('should prefer BLOCKED over CHALLENGE', () => {
      const results: RuleResult[] = [
        {
          ruleName: 'rule1',
          key: 'key1',
          allowed: false,
          outcome: 'BLOCKED',
          retryAfterMs: 30000,
          remainingTokens: 0,
        },
        {
          ruleName: 'rule2',
          key: 'key2',
          allowed: true,
          outcome: 'CHALLENGE',
          retryAfterMs: 0,
          remainingTokens: 0,
          challenge: 'captcha_required',
        },
      ];

      const decision = combineRuleResults('test', results, {});

      expect(decision.allowed).toBe(false);
      expect(decision.outcome).toBe('BLOCKED');
    });

    it('should include action in decision', () => {
      const decision = combineRuleResults('my_action', [], {});
      expect(decision.action).toBe('my_action');
    });

    it('should include keys in decision', () => {
      const keys = { rule1: 'key1', rule2: 'key2' };
      const decision = combineRuleResults('test', [], keys);
      expect(decision.keys).toEqual(keys);
    });
  });

  describe('createErrorDecision', () => {
    it('should create blocked decision for fail-closed', () => {
      const error = new Error('Store failed');
      const decision = createErrorDecision('test', 'closed', error);

      expect(decision.allowed).toBe(false);
      expect(decision.outcome).toBe('BLOCKED');
      expect(decision.failedDueToError).toBe(true);
      expect(decision.retryAfterMs).toBe(60000);
    });

    it('should create allowed decision for fail-open', () => {
      const error = new Error('Store failed');
      const decision = createErrorDecision('test', 'open', error);

      expect(decision.allowed).toBe(true);
      expect(decision.outcome).toBe('ALLOWED');
      expect(decision.failedDueToError).toBe(true);
      expect(decision.retryAfterMs).toBe(0);
    });

    it('should include error message in rule result', () => {
      const error = new Error('Connection timeout');
      const decision = createErrorDecision('test', 'closed', error);

      expect(decision.ruleResults[0]?.challenge).toContain('Connection timeout');
    });
  });

  describe('createMissingDimensionDecision', () => {
    it('should create blocked decision for fail-closed', () => {
      const decision = createMissingDimensionDecision('test', 'per_ip', ['ip'], 'closed');

      expect(decision.allowed).toBe(false);
      expect(decision.outcome).toBe('BLOCKED');
      expect(decision.failedDueToError).toBe(true);
    });

    it('should create allowed decision for fail-open', () => {
      const decision = createMissingDimensionDecision('test', 'per_ip', ['ip'], 'open');

      expect(decision.allowed).toBe(true);
      expect(decision.outcome).toBe('ALLOWED');
      expect(decision.failedDueToError).toBe(true);
    });

    it('should list missing dimensions', () => {
      const decision = createMissingDimensionDecision(
        'test',
        'per_ip',
        ['ip', 'sessionId'],
        'closed'
      );

      expect(decision.ruleResults[0]?.challenge).toContain('ip');
      expect(decision.ruleResults[0]?.challenge).toContain('sessionId');
    });
  });

  describe('createAllowedDecision', () => {
    it('should create basic allowed decision', () => {
      const decision = createAllowedDecision('test');

      expect(decision.allowed).toBe(true);
      expect(decision.action).toBe('test');
      expect(decision.outcome).toBe('ALLOWED');
      expect(decision.retryAfterMs).toBe(0);
      expect(decision.ruleResults).toEqual([]);
    });
  });

  describe('createBlockedDecision', () => {
    it('should create basic blocked decision', () => {
      const decision = createBlockedDecision('test', 30000, 'Rate limit exceeded');

      expect(decision.allowed).toBe(false);
      expect(decision.action).toBe('test');
      expect(decision.outcome).toBe('BLOCKED');
      expect(decision.retryAfterMs).toBe(30000);
      expect(decision.ruleResults[0]?.challenge).toBe('Rate limit exceeded');
    });
  });

  describe('formatDecisionForLogging', () => {
    it('should format decision with all fields', () => {
      const results: RuleResult[] = [
        {
          ruleName: 'rule1',
          key: 'key1',
          allowed: true,
          outcome: 'ALLOWED',
          retryAfterMs: 0,
          remainingTokens: 5,
        },
        {
          ruleName: 'rule2',
          key: 'key2',
          allowed: false,
          outcome: 'BLOCKED',
          retryAfterMs: 30000,
          remainingTokens: 0,
        },
      ];

      const decision = combineRuleResults('test', results, {});
      const formatted = formatDecisionForLogging(decision);

      expect(formatted).toEqual({
        allowed: false,
        action: 'test',
        outcome: 'BLOCKED',
        retryAfterMs: 30000,
        ruleCount: 2,
        failedRules: ['rule2'],
        challenge: undefined,
        failedDueToError: undefined,
      });
    });

    it('should include challenge if present', () => {
      const results: RuleResult[] = [
        {
          ruleName: 'rule1',
          key: 'key1',
          allowed: true,
          outcome: 'CHALLENGE',
          retryAfterMs: 0,
          remainingTokens: 0,
          challenge: 'captcha_required',
        },
      ];

      const decision = combineRuleResults('test', results, {});
      const formatted = formatDecisionForLogging(decision);

      expect(formatted).toMatchObject({
        challenge: 'captcha_required',
      });
    });
  });
});
