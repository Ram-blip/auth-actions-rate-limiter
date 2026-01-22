/**
 * auth-action-rate-limiter
 *
 * A modular, policy-driven, in-process rate limiter for abuse prevention
 * in sensitive authentication flows.
 *
 * IMPORTANT: This library provides IN-PROCESS rate limiting only.
 * It does NOT provide distributed rate limiting across multiple Node.js instances.
 * For distributed scenarios, use an external store like Redis.
 *
 * @packageDocumentation
 */

// Core types
export type {
  KeyDimension,
  RuleMode,
  FailMode,
  DecisionOutcome,
  RateLimitRule,
  ActionPolicy,
  RateLimiterConfig,
  TokenBucketState,
  ConsumeResult,
  RuleResult,
  RateLimitDecision,
  KeyExtractor,
  RequestContext,
  RateLimitStore,
  MemoryStoreOptions,
  OnDecisionCallback,
  Logger,
  RateLimiterMiddlewareOptions,
  RateLimiterMetrics,
} from './core/types.js';

// Token bucket
export {
  calculateRefillTokens,
  refillBucket,
  createBucket,
  consumeTokens,
  calculateRetryAfterMs,
  ruleToConfig,
  calculateDefaultTtl,
  isBucketExpired,
} from './core/tokenBucket.js';
export type { TokenBucketConfig } from './core/tokenBucket.js';

// Key builder
export {
  DefaultKeyExtractor,
  defaultKeyExtractor,
  buildKey,
  buildKeysForRules,
  parseKey,
  extractDimensionsForLogging,
  validateDimensions,
} from './core/keyBuilder.js';

// Decision utilities
export {
  combineRuleResults,
  createErrorDecision,
  createMissingDimensionDecision,
  createAllowedDecision,
  createBlockedDecision,
  formatDecisionForLogging,
} from './core/decision.js';

// Policy engine
export { PolicyEngine, createPolicyEngine } from './core/policyEngine.js';
export type { PolicyEngineOptions } from './core/policyEngine.js';

// Memory store
export { MemoryStore, createMemoryStore } from './stores/memoryStore.js';

// Express middleware
export { createRateLimiter, createPassiveRateLimiter } from './middleware/express.js';
export type {
  RateLimitedRequest,
  RateLimitErrorResponse,
  ActionMiddlewareOptions,
} from './middleware/express.js';

// Utilities
export { hashIdentifier, hashEmail, hashPhone, hashesMatch } from './utils/hash.js';
export {
  defaultTimeProvider,
  createMockTimeProvider,
  msToSeconds,
  parseDuration,
  TIME,
} from './utils/time.js';
export type { TimeProvider } from './utils/time.js';

// ============================================================================
// DEFAULT POLICIES
// ============================================================================

import type { ActionPolicy, RateLimitRule } from './core/types.js';
import { TIME } from './utils/time.js';

/**
 * Default rule for limiting password reset requests per IP.
 * Allows 5 requests per minute with burst.
 */
const passwordResetPerIp: RateLimitRule = {
  name: 'per_ip',
  key: ['ip'],
  capacity: 5,
  refillTokens: 5,
  refillIntervalMs: TIME.MINUTE,
  cost: 1,
  mode: 'block',
  ttlMs: TIME.MINUTE * 2,
};

/**
 * Default rule for limiting password reset requests per email.
 * Allows 3 requests per 15 minutes.
 */
const passwordResetPerEmail: RateLimitRule = {
  name: 'per_email',
  key: ['emailHash'],
  capacity: 3,
  refillTokens: 3,
  refillIntervalMs: TIME.MINUTE * 15,
  cost: 1,
  mode: 'block',
  ttlMs: TIME.MINUTE * 30,
};

/**
 * Default policy for password reset request endpoint.
 *
 * Fail mode: closed (security > availability for password reset)
 *
 * This policy should be used with enumeration-safe responses:
 * Always return the same success message regardless of whether
 * the user exists in the database.
 */
export const passwordResetRequestPolicy: ActionPolicy = {
  id: 'password_reset_request',
  rules: [passwordResetPerIp, passwordResetPerEmail],
  failMode: 'closed',
};

/**
 * Default rule for limiting registration per IP.
 * Allows 10 requests per hour.
 */
const registerPerIp: RateLimitRule = {
  name: 'per_ip',
  key: ['ip'],
  capacity: 10,
  refillTokens: 10,
  refillIntervalMs: TIME.HOUR,
  cost: 1,
  mode: 'block',
  ttlMs: TIME.HOUR * 2,
};

/**
 * Default rule for limiting registration per IP + email combination.
 * Allows 3 attempts per hour for the same email from the same IP.
 * Uses challenge mode to allow captcha verification.
 */
const registerPerIpEmail: RateLimitRule = {
  name: 'per_ip_email',
  key: ['ip', 'emailHash'],
  capacity: 3,
  refillTokens: 3,
  refillIntervalMs: TIME.HOUR,
  cost: 1,
  mode: 'challenge',
  ttlMs: TIME.HOUR * 2,
};

/**
 * Default policy for registration endpoint.
 *
 * Fail mode: open (availability > security for registration)
 *
 * Rationale: Registration is often the first user interaction.
 * Blocking legitimate users due to rate limiter errors is worse
 * than allowing a few extra registrations during errors.
 * The per-email rule uses challenge mode to require captcha
 * rather than blocking.
 */
export const registerPolicy: ActionPolicy = {
  id: 'register',
  rules: [registerPerIp, registerPerIpEmail],
  failMode: 'open',
};

/**
 * Default rule for limiting OTP send per session.
 * Allows 3 requests per 10 minutes.
 */
const otpSendPerSession: RateLimitRule = {
  name: 'per_session',
  key: ['sessionId'],
  capacity: 3,
  refillTokens: 3,
  refillIntervalMs: TIME.MINUTE * 10,
  cost: 1,
  mode: 'block',
  ttlMs: TIME.MINUTE * 20,
};

/**
 * Default rule for limiting OTP send per IP.
 * Allows 10 requests per hour.
 */
const otpSendPerIp: RateLimitRule = {
  name: 'per_ip',
  key: ['ip'],
  capacity: 10,
  refillTokens: 10,
  refillIntervalMs: TIME.HOUR,
  cost: 1,
  mode: 'block',
  ttlMs: TIME.HOUR * 2,
};

/**
 * Default policy for OTP send endpoint.
 *
 * Fail mode: closed (security > availability for OTP)
 */
export const otpSendPolicy: ActionPolicy = {
  id: 'otp_send',
  rules: [otpSendPerSession, otpSendPerIp],
  failMode: 'closed',
};

/**
 * Default rule for limiting OTP verification per session.
 * Allows 5 attempts per 10 minutes.
 */
const otpVerifyPerSession: RateLimitRule = {
  name: 'per_session',
  key: ['sessionId'],
  capacity: 5,
  refillTokens: 5,
  refillIntervalMs: TIME.MINUTE * 10,
  cost: 1,
  mode: 'block',
  ttlMs: TIME.MINUTE * 20,
};

/**
 * Default policy for OTP verify endpoint.
 *
 * Fail mode: closed (security > availability for OTP verification)
 */
export const otpVerifyPolicy: ActionPolicy = {
  id: 'otp_verify',
  rules: [otpVerifyPerSession],
  failMode: 'closed',
};

/**
 * Default rule for limiting login attempts per IP.
 * Allows 20 requests per hour.
 */
const loginPerIp: RateLimitRule = {
  name: 'per_ip',
  key: ['ip'],
  capacity: 20,
  refillTokens: 20,
  refillIntervalMs: TIME.HOUR,
  cost: 1,
  mode: 'block',
  ttlMs: TIME.HOUR * 2,
};

/**
 * Default rule for limiting login attempts per IP + email combination.
 * Allows 5 attempts per 15 minutes for the same account from the same IP.
 */
const loginPerIpEmail: RateLimitRule = {
  name: 'per_ip_email',
  key: ['ip', 'emailHash'],
  capacity: 5,
  refillTokens: 5,
  refillIntervalMs: TIME.MINUTE * 15,
  cost: 1,
  mode: 'block',
  ttlMs: TIME.MINUTE * 30,
};

/**
 * Default policy for login endpoint.
 *
 * Fail mode: closed (security > availability for login)
 */
export const loginPolicy: ActionPolicy = {
  id: 'login',
  rules: [loginPerIp, loginPerIpEmail],
  failMode: 'closed',
};

/**
 * All default policies bundled together.
 */
export const defaultPolicies: Record<string, ActionPolicy> = {
  password_reset_request: passwordResetRequestPolicy,
  register: registerPolicy,
  otp_send: otpSendPolicy,
  otp_verify: otpVerifyPolicy,
  login: loginPolicy,
};

/**
 * Create a customized copy of the default policies.
 *
 * @param overrides - Partial overrides for specific policies
 * @returns New policies object with overrides applied
 *
 * @example
 * ```typescript
 * const policies = customizePolicies({
 *   password_reset_request: {
 *     rules: [
 *       { ...passwordResetPerIp, capacity: 10 }, // More lenient
 *     ],
 *   },
 * });
 * ```
 */
export function customizePolicies(
  overrides: Partial<Record<string, Partial<ActionPolicy>>>
): Record<string, ActionPolicy> {
  const result: Record<string, ActionPolicy> = { ...defaultPolicies };

  for (const [actionId, override] of Object.entries(overrides)) {
    const existing = result[actionId];
    if (existing && override) {
      result[actionId] = {
        ...existing,
        ...override,
        id: actionId, // Ensure ID matches key
      };
    } else if (override) {
      result[actionId] = {
        id: actionId,
        rules: override.rules ?? [],
        failMode: override.failMode ?? 'closed',
      };
    }
  }

  return result;
}
