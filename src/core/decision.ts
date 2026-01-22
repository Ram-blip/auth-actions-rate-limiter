/**
 * Decision Types and Utilities
 *
 * This module defines the decision-making logic for rate limiting,
 * including combining multiple rule results with AND semantics.
 */

import type { RateLimitDecision, RuleResult, DecisionOutcome, FailMode } from './types.js';

/**
 * Combine multiple rule results into a final decision.
 *
 * AND Semantics: A request is allowed only if ALL rules pass.
 * - If any rule blocks, the decision is BLOCKED
 * - If all rules pass but some return CHALLENGE, the decision is CHALLENGE
 * - If all rules pass with ALLOWED, the decision is ALLOWED
 *
 * @param action - The action being checked
 * @param ruleResults - Results from all rule evaluations
 * @param keys - The keys that were checked
 * @returns Combined decision
 */
export function combineRuleResults(
  action: string,
  ruleResults: RuleResult[],
  keys: Record<string, string>
): RateLimitDecision {
  // If no rules, allow by default
  if (ruleResults.length === 0) {
    return {
      allowed: true,
      action,
      outcome: 'ALLOWED',
      retryAfterMs: 0,
      ruleResults: [],
      keys,
    };
  }

  // Find the most restrictive outcome
  let hasBlock = false;
  let hasChallenge = false;
  let maxRetryAfterMs = 0;
  let challengeHint: string | undefined;

  for (const result of ruleResults) {
    if (result.outcome === 'BLOCKED') {
      hasBlock = true;
      maxRetryAfterMs = Math.max(maxRetryAfterMs, result.retryAfterMs);
    } else if (result.outcome === 'CHALLENGE') {
      hasChallenge = true;
      challengeHint = challengeHint || result.challenge;
    }
  }

  // Determine final outcome
  let outcome: DecisionOutcome;
  let allowed: boolean;

  if (hasBlock) {
    outcome = 'BLOCKED';
    allowed = false;
  } else if (hasChallenge) {
    outcome = 'CHALLENGE';
    // Challenge allows the request to proceed but signals need for challenge
    allowed = true;
  } else {
    outcome = 'ALLOWED';
    allowed = true;
  }

  const decision: RateLimitDecision = {
    allowed,
    action,
    outcome,
    retryAfterMs: maxRetryAfterMs,
    ruleResults,
    keys,
  };

  if (challengeHint) {
    decision.challenge = challengeHint;
  }

  return decision;
}

/**
 * Create a decision for when a store error occurs.
 *
 * @param action - The action being checked
 * @param failMode - How to handle the failure
 * @param error - The error that occurred
 * @returns Decision based on fail mode
 */
export function createErrorDecision(
  action: string,
  failMode: FailMode,
  error: Error
): RateLimitDecision {
  const allowed = failMode === 'open';
  const outcome: DecisionOutcome = allowed ? 'ALLOWED' : 'BLOCKED';

  return {
    allowed,
    action,
    outcome,
    retryAfterMs: allowed ? 0 : 60_000, // 1 minute retry if blocked on error
    ruleResults: [
      {
        ruleName: 'store_error',
        key: 'error',
        allowed,
        outcome,
        retryAfterMs: allowed ? 0 : 60_000,
        remainingTokens: 0,
        challenge: `Store error: ${error.message}`,
      },
    ],
    keys: {},
    failedDueToError: true,
  };
}

/**
 * Create a decision for when a required dimension is missing.
 *
 * @param action - The action being checked
 * @param ruleName - The rule that had missing dimensions
 * @param missingDimensions - The dimensions that were missing
 * @param failMode - How to handle the failure
 * @returns Decision based on fail mode
 */
export function createMissingDimensionDecision(
  action: string,
  ruleName: string,
  missingDimensions: string[],
  failMode: FailMode
): RateLimitDecision {
  const allowed = failMode === 'open';
  const outcome: DecisionOutcome = allowed ? 'ALLOWED' : 'BLOCKED';

  return {
    allowed,
    action,
    outcome,
    retryAfterMs: 0,
    ruleResults: [
      {
        ruleName,
        key: 'missing_dimensions',
        allowed,
        outcome,
        retryAfterMs: 0,
        remainingTokens: 0,
        challenge: `Missing dimensions: ${missingDimensions.join(', ')}`,
      },
    ],
    keys: {},
    failedDueToError: true,
  };
}

/**
 * Create an allowed decision (for cases like no matching policy).
 *
 * @param action - The action being checked
 * @returns An allowed decision
 */
export function createAllowedDecision(action: string): RateLimitDecision {
  return {
    allowed: true,
    action,
    outcome: 'ALLOWED',
    retryAfterMs: 0,
    ruleResults: [],
    keys: {},
  };
}

/**
 * Create a blocked decision.
 *
 * @param action - The action being checked
 * @param retryAfterMs - Milliseconds until retry
 * @param reason - Reason for blocking
 * @returns A blocked decision
 */
export function createBlockedDecision(
  action: string,
  retryAfterMs: number,
  reason: string
): RateLimitDecision {
  return {
    allowed: false,
    action,
    outcome: 'BLOCKED',
    retryAfterMs,
    ruleResults: [
      {
        ruleName: 'manual_block',
        key: 'manual',
        allowed: false,
        outcome: 'BLOCKED',
        retryAfterMs,
        remainingTokens: 0,
        challenge: reason,
      },
    ],
    keys: {},
  };
}

/**
 * Format a decision for logging.
 *
 * @param decision - The decision to format
 * @returns Object suitable for structured logging
 */
export function formatDecisionForLogging(decision: RateLimitDecision): object {
  return {
    allowed: decision.allowed,
    action: decision.action,
    outcome: decision.outcome,
    retryAfterMs: decision.retryAfterMs,
    ruleCount: decision.ruleResults.length,
    failedRules: decision.ruleResults.filter((r) => !r.allowed).map((r) => r.ruleName),
    challenge: decision.challenge,
    failedDueToError: decision.failedDueToError,
  };
}
