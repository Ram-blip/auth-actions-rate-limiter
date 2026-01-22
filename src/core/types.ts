/**
 * Core types for the auth-action-rate-limiter library.
 *
 * This library is designed for IN-PROCESS rate limiting within a single Node.js process.
 * It does NOT provide distributed rate limiting across multiple instances.
 */

/**
 * Supported key dimensions for rate limiting.
 * These can be combined to create composite keys.
 */
export type KeyDimension =
  | 'ip'
  | 'emailHash'
  | 'phoneHash'
  | 'userId'
  | 'sessionId'
  | 'action'
  | 'route';

/**
 * The mode for what happens when a rate limit is exceeded.
 * - 'block': Return 429 and deny the request
 * - 'challenge': Allow the request but signal that a challenge (e.g., captcha) should be presented
 */
export type RuleMode = 'block' | 'challenge';

/**
 * Behavior when the store throws an error.
 * - 'open': Allow the request (fail-open) - good for registration where availability matters
 * - 'closed': Deny the request (fail-closed) - good for sensitive actions like password reset
 */
export type FailMode = 'open' | 'closed';

/**
 * Outcome of a rate limit decision.
 */
export type DecisionOutcome = 'ALLOWED' | 'BLOCKED' | 'CHALLENGE';

/**
 * Configuration for a single rate limiting rule.
 */
export interface RateLimitRule {
  /** Unique name for this rule within the action policy */
  name: string;

  /**
   * Key dimensions to use for this rule.
   * Multiple dimensions are combined (e.g., ['ip', 'emailHash'] for per-IP-per-email limiting).
   */
  key: KeyDimension[];

  /**
   * Maximum number of tokens (burst capacity).
   * This is the maximum number of requests that can be made in a burst.
   */
  capacity: number;

  /**
   * Number of tokens to add during each refill.
   */
  refillTokens: number;

  /**
   * Interval in milliseconds between token refills.
   */
  refillIntervalMs: number;

  /**
   * Token cost per request. Defaults to 1.
   */
  cost?: number;

  /**
   * What happens when this rule's limit is exceeded.
   * Defaults to 'block'.
   */
  mode?: RuleMode;

  /**
   * TTL in milliseconds for the bucket entry in the store.
   * After this time with no activity, the entry can be evicted.
   * Defaults to refillIntervalMs * (capacity / refillTokens) * 2 if not specified.
   */
  ttlMs?: number;
}

/**
 * Policy configuration for a specific action (e.g., password_reset_request).
 */
export interface ActionPolicy {
  /** Unique identifier for this action (e.g., 'password_reset_request') */
  id: string;

  /** Array of rules that ALL must pass for the request to be allowed */
  rules: RateLimitRule[];

  /**
   * Behavior when the store throws an error.
   * - 'open': Allow request on store error (availability > security)
   * - 'closed': Deny request on store error (security > availability)
   */
  failMode: FailMode;
}

/**
 * Complete rate limiter configuration with all policies.
 */
export interface RateLimiterConfig {
  /** Map of action ID to policy configuration */
  policies: Record<string, ActionPolicy>;
}

/**
 * Token bucket state stored per key.
 */
export interface TokenBucketState {
  /** Current number of available tokens */
  tokens: number;

  /** Timestamp (ms) when tokens were last updated */
  lastRefillTime: number;

  /** Timestamp (ms) when this entry was created */
  createdAt: number;

  /** TTL timestamp (ms) after which this entry can be evicted */
  expiresAt: number;
}

/**
 * Result of consuming tokens from a bucket.
 */
export interface ConsumeResult {
  /** Whether the tokens were successfully consumed */
  allowed: boolean;

  /** Remaining tokens after consumption (0 if not allowed) */
  remainingTokens: number;

  /** Milliseconds until enough tokens will be available (0 if allowed) */
  retryAfterMs: number;

  /** Current state of the bucket */
  bucketState: TokenBucketState;
}

/**
 * Result of evaluating a single rule.
 */
export interface RuleResult {
  /** Name of the rule */
  ruleName: string;

  /** The computed key for this rule */
  key: string;

  /** Whether this rule passed */
  allowed: boolean;

  /** Outcome based on the rule's mode */
  outcome: DecisionOutcome;

  /** Milliseconds until retry is possible (if not allowed) */
  retryAfterMs: number;

  /** Remaining tokens for this rule */
  remainingTokens: number;

  /** Challenge hint if outcome is CHALLENGE */
  challenge?: string;
}

/**
 * Final decision for a rate limit check.
 */
export interface RateLimitDecision {
  /** Whether the request is allowed to proceed */
  allowed: boolean;

  /** The action that was checked */
  action: string;

  /** Overall outcome */
  outcome: DecisionOutcome;

  /**
   * Milliseconds until retry is possible.
   * This is the maximum retryAfterMs across all failed rules.
   */
  retryAfterMs: number;

  /** Results from each rule evaluation */
  ruleResults: RuleResult[];

  /** The keys that were checked */
  keys: Record<string, string>;

  /** Challenge hint if any rule returned CHALLENGE */
  challenge?: string;

  /** Whether this decision was made due to a store error */
  failedDueToError?: boolean;
}

/**
 * Interface for key value extractors.
 * Implementations extract values from the request context.
 */
export interface KeyExtractor {
  /** Extract the value for a given dimension from the request context */
  extract(dimension: KeyDimension, context: RequestContext): string | undefined;
}

/**
 * Context passed to the rate limiter for each request.
 */
export interface RequestContext {
  /** Client IP address */
  ip?: string;

  /** Hashed email (use hashIdentifier utility) */
  emailHash?: string;

  /** Hashed phone number (use hashIdentifier utility) */
  phoneHash?: string;

  /** User ID if authenticated */
  userId?: string;

  /** Session ID */
  sessionId?: string;

  /** The action being performed */
  action: string;

  /** The route/path being accessed */
  route?: string;

  /** Additional custom fields */
  [key: string]: string | undefined;
}

/**
 * Interface for the rate limit store.
 * The store is responsible for persisting and retrieving token bucket states.
 */
export interface RateLimitStore {
  /**
   * Get the current bucket state for a key.
   * Returns undefined if no bucket exists.
   */
  get(key: string): Promise<TokenBucketState | undefined>;

  /**
   * Set/update the bucket state for a key.
   * @param key - The bucket key
   * @param state - The bucket state to store
   * @param ttlMs - Time-to-live in milliseconds
   */
  set(key: string, state: TokenBucketState, ttlMs: number): Promise<void>;

  /**
   * Delete a bucket entry.
   */
  delete(key: string): Promise<void>;

  /**
   * Check if the store has a key.
   */
  has(key: string): Promise<boolean>;

  /**
   * Get the current size of the store.
   */
  size(): Promise<number>;

  /**
   * Clear all entries from the store.
   */
  clear(): Promise<void>;

  /**
   * Shutdown the store (cleanup timers, etc.).
   */
  shutdown(): Promise<void>;
}

/**
 * Options for creating a MemoryStore.
 */
export interface MemoryStoreOptions {
  /**
   * Interval in milliseconds for the periodic sweeper.
   * The sweeper removes expired entries.
   * Defaults to 60000 (1 minute).
   */
  sweepIntervalMs?: number;

  /**
   * Maximum number of entries in the store.
   * When exceeded, oldest expired entries are evicted first,
   * then oldest entries by creation time if needed.
   * Defaults to 100000.
   */
  highWaterMark?: number;

  /**
   * Number of entries to evict when highWaterMark is reached.
   * Defaults to 10% of highWaterMark.
   */
  evictionCount?: number;
}

/**
 * Callback for rate limit decisions (observability).
 */
export type OnDecisionCallback = (decision: RateLimitDecision) => void;

/**
 * Logger interface compatible with pino.
 */
export interface Logger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/**
 * Options for the Express middleware factory.
 */
export interface RateLimiterMiddlewareOptions {
  /** The store to use for rate limiting */
  store: RateLimitStore;

  /** Map of action ID to policy */
  policies: Record<string, ActionPolicy>;

  /** Custom key extractor (optional, uses default if not provided) */
  keyExtractor?: KeyExtractor;

  /** Callback for observability on each decision */
  onDecision?: OnDecisionCallback;

  /** Logger instance */
  logger?: Logger;

  /** Whether to enable Prometheus metrics */
  enableMetrics?: boolean;

  /** Secret for HMAC hashing of identifiers */
  hashSecret?: string;
}

/**
 * Metrics interface for Prometheus integration.
 */
export interface RateLimiterMetrics {
  /** Increment the request counter */
  incRequests(action: string, outcome: DecisionOutcome): void;

  /** Observe latency */
  observeLatency(action: string, durationMs: number): void;

  /** Update store size gauge */
  setStoreSize(size: number): void;
}
