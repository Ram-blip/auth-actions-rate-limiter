/**
 * Token Bucket Algorithm Implementation
 *
 * The token bucket algorithm allows for burst traffic while maintaining
 * an average rate limit over time. Tokens are added to the bucket at a
 * fixed rate, and each request consumes tokens.
 *
 * Key properties:
 * - Capacity: Maximum tokens the bucket can hold (burst limit)
 * - Refill rate: Tokens added per interval
 * - Cost: Tokens consumed per request
 */

import type { TokenBucketState, ConsumeResult, RateLimitRule } from './types.js';

/**
 * Configuration for a token bucket.
 */
export interface TokenBucketConfig {
  /** Maximum tokens the bucket can hold */
  capacity: number;

  /** Number of tokens to add per refill */
  refillTokens: number;

  /** Interval between refills in milliseconds */
  refillIntervalMs: number;
}

/**
 * Calculate the number of tokens to refill based on elapsed time.
 *
 * @param elapsedMs - Time elapsed since last refill in milliseconds
 * @param config - Token bucket configuration
 * @returns Number of tokens to add (may be fractional for precision)
 */
export function calculateRefillTokens(elapsedMs: number, config: TokenBucketConfig): number {
  if (elapsedMs <= 0 || config.refillIntervalMs <= 0) {
    return 0;
  }

  // Calculate how many complete refill intervals have passed
  const intervals = elapsedMs / config.refillIntervalMs;

  // Calculate tokens to add
  return intervals * config.refillTokens;
}

/**
 * Refill the token bucket based on elapsed time.
 *
 * @param state - Current bucket state
 * @param config - Token bucket configuration
 * @param currentTime - Current timestamp in milliseconds
 * @returns Updated bucket state with refilled tokens
 */
export function refillBucket(
  state: TokenBucketState,
  config: TokenBucketConfig,
  currentTime: number
): TokenBucketState {
  const elapsedMs = currentTime - state.lastRefillTime;

  if (elapsedMs <= 0) {
    return state;
  }

  const tokensToAdd = calculateRefillTokens(elapsedMs, config);
  const newTokens = Math.min(config.capacity, state.tokens + tokensToAdd);

  return {
    ...state,
    tokens: newTokens,
    lastRefillTime: currentTime,
  };
}

/**
 * Create a new token bucket state.
 *
 * @param config - Token bucket configuration
 * @param currentTime - Current timestamp in milliseconds
 * @param ttlMs - Time-to-live for the bucket entry
 * @returns Initial bucket state with full capacity
 */
export function createBucket(
  config: TokenBucketConfig,
  currentTime: number,
  ttlMs: number
): TokenBucketState {
  return {
    tokens: config.capacity,
    lastRefillTime: currentTime,
    createdAt: currentTime,
    expiresAt: currentTime + ttlMs,
  };
}

/**
 * Attempt to consume tokens from the bucket.
 *
 * @param state - Current bucket state
 * @param config - Token bucket configuration
 * @param cost - Number of tokens to consume
 * @param currentTime - Current timestamp in milliseconds
 * @param ttlMs - TTL to extend the bucket expiry
 * @returns Result indicating if consumption was successful and new state
 */
export function consumeTokens(
  state: TokenBucketState,
  config: TokenBucketConfig,
  cost: number,
  currentTime: number,
  ttlMs: number
): ConsumeResult {
  // First, refill the bucket based on elapsed time
  const refilledState = refillBucket(state, config, currentTime);

  // Check if we have enough tokens
  if (refilledState.tokens >= cost) {
    // Consume the tokens
    const newState: TokenBucketState = {
      ...refilledState,
      tokens: refilledState.tokens - cost,
      expiresAt: currentTime + ttlMs,
    };

    return {
      allowed: true,
      remainingTokens: newState.tokens,
      retryAfterMs: 0,
      bucketState: newState,
    };
  }

  // Not enough tokens - calculate retry time
  const tokensNeeded = cost - refilledState.tokens;
  const retryAfterMs = calculateRetryAfterMs(tokensNeeded, config);

  // Update expiry even on failed attempt (to track activity)
  const updatedState: TokenBucketState = {
    ...refilledState,
    expiresAt: currentTime + ttlMs,
  };

  return {
    allowed: false,
    remainingTokens: refilledState.tokens,
    retryAfterMs,
    bucketState: updatedState,
  };
}

/**
 * Calculate milliseconds until enough tokens are available.
 *
 * @param tokensNeeded - Number of tokens needed
 * @param config - Token bucket configuration
 * @returns Milliseconds until tokens will be available
 */
export function calculateRetryAfterMs(tokensNeeded: number, config: TokenBucketConfig): number {
  if (tokensNeeded <= 0) {
    return 0;
  }

  if (config.refillTokens <= 0 || config.refillIntervalMs <= 0) {
    // No refill configured - return a large value
    return Number.MAX_SAFE_INTEGER;
  }

  // Calculate how many refill intervals are needed
  const intervalsNeeded = tokensNeeded / config.refillTokens;

  // Convert to milliseconds and round up
  return Math.ceil(intervalsNeeded * config.refillIntervalMs);
}

/**
 * Extract token bucket config from a rate limit rule.
 *
 * @param rule - Rate limit rule
 * @returns Token bucket configuration
 */
export function ruleToConfig(rule: RateLimitRule): TokenBucketConfig {
  return {
    capacity: rule.capacity,
    refillTokens: rule.refillTokens,
    refillIntervalMs: rule.refillIntervalMs,
  };
}

/**
 * Calculate default TTL for a rule if not specified.
 * Default is twice the time it takes to fully refill the bucket.
 *
 * @param rule - Rate limit rule
 * @returns TTL in milliseconds
 */
export function calculateDefaultTtl(rule: RateLimitRule): number {
  if (rule.ttlMs !== undefined) {
    return rule.ttlMs;
  }

  // Time to fully refill = (capacity / refillTokens) * refillIntervalMs
  // Default TTL = 2x that time
  const fullRefillTime = (rule.capacity / rule.refillTokens) * rule.refillIntervalMs;
  return Math.ceil(fullRefillTime * 2);
}

/**
 * Check if a bucket state has expired.
 *
 * @param state - Bucket state to check
 * @param currentTime - Current timestamp in milliseconds
 * @returns True if the bucket has expired
 */
export function isBucketExpired(state: TokenBucketState, currentTime: number): boolean {
  return currentTime >= state.expiresAt;
}
