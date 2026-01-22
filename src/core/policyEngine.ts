/**
 * Policy Engine
 *
 * The policy engine evaluates rate limit rules against requests.
 * It implements AND semantics: a request is allowed only if ALL rules pass.
 */

import type {
  ActionPolicy,
  RateLimitDecision,
  RateLimitRule,
  RateLimitStore,
  RequestContext,
  RuleResult,
  KeyExtractor,
  Logger,
  DecisionOutcome,
} from './types.js';
import { buildKey, defaultKeyExtractor } from './keyBuilder.js';
import {
  consumeTokens,
  createBucket,
  ruleToConfig,
  calculateDefaultTtl,
  isBucketExpired,
} from './tokenBucket.js';
import { combineRuleResults, createErrorDecision, createAllowedDecision } from './decision.js';

/**
 * Options for the policy engine.
 */
export interface PolicyEngineOptions {
  /** The store to use for rate limiting */
  store: RateLimitStore;

  /** Map of action ID to policy */
  policies: Record<string, ActionPolicy>;

  /** Custom key extractor (optional) */
  keyExtractor?: KeyExtractor;

  /** Logger instance */
  logger?: Logger;

  /** Time provider for testing (defaults to Date.now) */
  timeProvider?: () => number;
}

/**
 * Policy Engine for evaluating rate limits.
 *
 * @example
 * ```typescript
 * const engine = new PolicyEngine({
 *   store,
 *   policies: {
 *     password_reset_request: {
 *       id: 'password_reset_request',
 *       rules: [...],
 *       failMode: 'closed',
 *     },
 *   },
 * });
 *
 * const decision = await engine.check({
 *   action: 'password_reset_request',
 *   ip: '192.168.1.1',
 *   emailHash: 'abc123...',
 * });
 * ```
 */
export class PolicyEngine {
  private readonly store: RateLimitStore;
  private readonly policies: Record<string, ActionPolicy>;
  private readonly keyExtractor: KeyExtractor;
  private readonly logger?: Logger;
  private readonly getTime: () => number;

  constructor(options: PolicyEngineOptions) {
    this.store = options.store;
    this.policies = options.policies;
    this.keyExtractor = options.keyExtractor ?? defaultKeyExtractor;
    this.logger = options.logger;
    this.getTime = options.timeProvider ?? (() => Date.now());
  }

  /**
   * Check if a request is allowed based on the configured policies.
   *
   * @param context - The request context
   * @returns Rate limit decision
   */
  async check(context: RequestContext): Promise<RateLimitDecision> {
    const { action } = context;
    const policy = this.policies[action];

    // If no policy exists for this action, allow by default
    if (!policy) {
      this.logger?.debug({ action }, 'No policy found for action, allowing');
      return createAllowedDecision(action);
    }

    try {
      return await this.evaluatePolicy(policy, context);
    } catch (error) {
      // Handle store errors based on fail mode
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger?.error({ action, error: err.message }, 'Store error during rate limit check');
      return createErrorDecision(action, policy.failMode, err);
    }
  }

  /**
   * Evaluate a policy against a request context.
   */
  private async evaluatePolicy(
    policy: ActionPolicy,
    context: RequestContext
  ): Promise<RateLimitDecision> {
    const ruleResults: RuleResult[] = [];
    const keys: Record<string, string> = {};

    // Evaluate each rule
    for (const rule of policy.rules) {
      const result = await this.evaluateRule(rule, context, policy);

      if (result.key !== 'skipped') {
        keys[rule.name] = result.key;
      }

      ruleResults.push(result);

      // Short-circuit on block if any rule blocks
      // This is an optimization - we could continue to get all results
      // but for security, blocking early is preferred
      if (result.outcome === 'BLOCKED') {
        this.logger?.debug(
          { action: policy.id, ruleName: rule.name },
          'Rule blocked request, short-circuiting'
        );
        // Continue to evaluate remaining rules for complete metrics
      }
    }

    return combineRuleResults(policy.id, ruleResults, keys);
  }

  /**
   * Evaluate a single rule against a request context.
   */
  private async evaluateRule(
    rule: RateLimitRule,
    context: RequestContext,
    policy: ActionPolicy
  ): Promise<RuleResult> {
    // Build the key for this rule
    const key = buildKey(policy.id, rule, context, this.keyExtractor);

    // If key cannot be built (missing dimensions), handle based on fail mode
    if (key === undefined) {
      this.logger?.warn(
        { action: policy.id, ruleName: rule.name, dimensions: rule.key },
        'Cannot build key - missing dimensions'
      );

      // For missing dimensions, we skip the rule (allow) rather than fail
      // This is because the rule simply doesn't apply to this request
      return {
        ruleName: rule.name,
        key: 'skipped',
        allowed: true,
        outcome: 'ALLOWED',
        retryAfterMs: 0,
        remainingTokens: rule.capacity,
      };
    }

    const now = this.getTime();
    const config = ruleToConfig(rule);
    const ttlMs = calculateDefaultTtl(rule);
    const cost = rule.cost ?? 1;

    // Get or create bucket
    let bucketState = await this.store.get(key);

    if (!bucketState || isBucketExpired(bucketState, now)) {
      // Create new bucket with full capacity
      bucketState = createBucket(config, now, ttlMs);
    }

    // Attempt to consume tokens
    const consumeResult = consumeTokens(bucketState, config, cost, now, ttlMs);

    // Save updated state
    await this.store.set(key, consumeResult.bucketState, ttlMs);

    // Determine outcome based on rule mode
    const mode = rule.mode ?? 'block';
    let outcome: DecisionOutcome;
    let challenge: string | undefined;

    if (consumeResult.allowed) {
      outcome = 'ALLOWED';
    } else if (mode === 'challenge') {
      outcome = 'CHALLENGE';
      challenge = 'captcha_required';
    } else {
      outcome = 'BLOCKED';
    }

    return {
      ruleName: rule.name,
      key,
      allowed: consumeResult.allowed,
      outcome,
      retryAfterMs: consumeResult.retryAfterMs,
      remainingTokens: consumeResult.remainingTokens,
      challenge,
    };
  }

  /**
   * Get a policy by action ID.
   */
  getPolicy(actionId: string): ActionPolicy | undefined {
    return this.policies[actionId];
  }

  /**
   * List all configured action IDs.
   */
  listActions(): string[] {
    return Object.keys(this.policies);
  }
}

/**
 * Create a policy engine with the given options.
 */
export function createPolicyEngine(options: PolicyEngineOptions): PolicyEngine {
  return new PolicyEngine(options);
}
