/**
 * Express Middleware for Rate Limiting
 *
 * Provides middleware factories for integrating the rate limiter with Express applications.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type {
  RateLimiterMiddlewareOptions,
  RateLimitDecision,
  RequestContext,
  Logger,
  RateLimiterMetrics,
} from '../core/types.js';
import { PolicyEngine } from '../core/policyEngine.js';
import { hashEmail, hashPhone } from '../utils/hash.js';
import { msToSeconds } from '../utils/time.js';

/**
 * Extended Express Request with rate limiter context.
 */
export interface RateLimitedRequest extends Request {
  /** Rate limit decision (if middleware was applied) */
  rateLimitDecision?: RateLimitDecision;

  /** Session ID (if available) */
  sessionId?: string;

  /** User ID (if authenticated) */
  userId?: string;
}

/**
 * Error response returned when rate limited.
 */
export interface RateLimitErrorResponse {
  error: 'RATE_LIMITED';
  action: string;
  retryAfterMs: number;
  outcome: string;
  challenge?: string;
}

/**
 * Options for a specific rate limit middleware.
 */
export interface ActionMiddlewareOptions {
  /** The action ID to use for rate limiting */
  action: string;

  /**
   * Function to extract email from request.
   * If provided, it will be hashed automatically.
   */
  getEmail?: (req: Request) => string | undefined;

  /**
   * Function to extract phone from request.
   * If provided, it will be hashed automatically.
   */
  getPhone?: (req: Request) => string | undefined;

  /**
   * Function to extract session ID from request.
   */
  getSessionId?: (req: Request) => string | undefined;

  /**
   * Function to extract user ID from request.
   */
  getUserId?: (req: Request) => string | undefined;

  /**
   * Skip rate limiting if this function returns true.
   */
  skip?: (req: Request) => boolean;
}

/**
 * Create the main rate limiter middleware factory.
 *
 * @param options - Rate limiter configuration
 * @returns A factory function for creating action-specific middleware
 *
 * @example
 * ```typescript
 * const rateLimiter = createRateLimiter({
 *   store: new MemoryStore(),
 *   policies: defaultPolicies,
 *   hashSecret: process.env.HASH_SECRET,
 * });
 *
 * // Apply to password reset endpoint
 * app.post('/auth/password-reset/request',
 *   rateLimiter.forAction({
 *     action: 'password_reset_request',
 *     getEmail: (req) => req.body.email,
 *   }),
 *   passwordResetHandler
 * );
 * ```
 */
export function createRateLimiter(options: RateLimiterMiddlewareOptions): {
  forAction: (actionOptions: ActionMiddlewareOptions) => RequestHandler;
  engine: PolicyEngine;
  shutdown: () => Promise<void>;
} {
  const { store, policies, onDecision, logger, hashSecret } = options;

  // Create the policy engine
  const engine = new PolicyEngine({
    store,
    policies,
    keyExtractor: options.keyExtractor,
    logger,
  });

  // Set up metrics if enabled
  let metrics: RateLimiterMetrics | undefined;
  if (options.enableMetrics) {
    metrics = createMetrics();
  }

  /**
   * Create middleware for a specific action.
   */
  function forAction(actionOptions: ActionMiddlewareOptions): RequestHandler {
    const { action, getEmail, getPhone, getSessionId, getUserId, skip } = actionOptions;

    // Wrap async handler to properly handle errors
    const asyncHandler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const startTime = Date.now();

      try {
        // Check if we should skip rate limiting
        if (skip?.(req)) {
          logger?.debug({ action }, 'Rate limiting skipped');
          next();
          return;
        }

        // Build request context
        const context = buildRequestContext(
          req,
          action,
          { getEmail, getPhone, getSessionId, getUserId },
          hashSecret,
          logger
        );

        // Check rate limit
        const decision = await engine.check(context);

        // Store decision on request for downstream use
        (req as RateLimitedRequest).rateLimitDecision = decision;

        // Record metrics
        if (metrics) {
          metrics.incRequests(action, decision.outcome);
          metrics.observeLatency(action, Date.now() - startTime);
        }

        // Call decision hook
        onDecision?.(decision);

        // Log the decision
        logger?.info(
          {
            action,
            allowed: decision.allowed,
            outcome: decision.outcome,
            retryAfterMs: decision.retryAfterMs,
            ip: context.ip,
          },
          'Rate limit decision'
        );

        // Handle the decision
        if (!decision.allowed) {
          // Set Retry-After header (in seconds)
          const retryAfterSeconds = msToSeconds(decision.retryAfterMs);
          res.setHeader('Retry-After', retryAfterSeconds.toString());

          // Return 429 with details
          const errorResponse: RateLimitErrorResponse = {
            error: 'RATE_LIMITED',
            action,
            retryAfterMs: decision.retryAfterMs,
            outcome: decision.outcome,
          };

          if (decision.challenge) {
            errorResponse.challenge = decision.challenge;
          }

          res.status(429).json(errorResponse);
          return;
        }

        // If CHALLENGE outcome, set header but allow through
        if (decision.outcome === 'CHALLENGE') {
          res.setHeader('X-RateLimit-Challenge', decision.challenge ?? 'required');
        }

        // Allow request to proceed
        next();
      } catch (error) {
        // Log the error
        const err = error instanceof Error ? error : new Error(String(error));
        logger?.error({ action, error: err.message }, 'Rate limiter error');

        // Get policy to determine fail mode
        const policy = engine.getPolicy(action);
        const failMode = policy?.failMode ?? 'closed';

        if (failMode === 'open') {
          // Fail open - allow the request
          logger?.warn({ action }, 'Failing open due to error');
          next();
        } else {
          // Fail closed - return 429
          res.setHeader('Retry-After', '60');
          res.status(429).json({
            error: 'RATE_LIMITED',
            action,
            retryAfterMs: 60_000,
            outcome: 'BLOCKED',
          } satisfies RateLimitErrorResponse);
        }
      }
    };

    // Return wrapper that properly handles async errors
    return (req: Request, res: Response, next: NextFunction): void => {
      asyncHandler(req, res, next).catch(next);
    };
  }

  /**
   * Shutdown the rate limiter.
   */
  async function shutdown(): Promise<void> {
    await store.shutdown();
  }

  return {
    forAction,
    engine,
    shutdown,
  };
}

/**
 * Build a request context from an Express request.
 */
function buildRequestContext(
  req: Request,
  action: string,
  extractors: {
    getEmail?: (req: Request) => string | undefined;
    getPhone?: (req: Request) => string | undefined;
    getSessionId?: (req: Request) => string | undefined;
    getUserId?: (req: Request) => string | undefined;
  },
  hashSecret?: string,
  logger?: Logger
): RequestContext {
  const context: RequestContext = {
    action,
    route: req.path,
  };

  // Extract IP address
  // Handle X-Forwarded-For for reverse proxy scenarios
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string') {
    // Take the first IP (client IP)
    context.ip = forwardedFor.split(',')[0]?.trim();
  } else if (Array.isArray(forwardedFor) && forwardedFor.length > 0) {
    context.ip = forwardedFor[0]?.split(',')[0]?.trim();
  } else {
    context.ip = req.ip ?? req.socket.remoteAddress;
  }

  // Extract and hash email
  if (extractors.getEmail && hashSecret) {
    const email = extractors.getEmail(req);
    if (email) {
      try {
        context.emailHash = hashEmail(email, hashSecret);
      } catch (error) {
        logger?.warn({ error }, 'Failed to hash email');
      }
    }
  }

  // Extract and hash phone
  if (extractors.getPhone && hashSecret) {
    const phone = extractors.getPhone(req);
    if (phone) {
      try {
        context.phoneHash = hashPhone(phone, hashSecret);
      } catch (error) {
        logger?.warn({ error }, 'Failed to hash phone');
      }
    }
  }

  // Extract session ID
  if (extractors.getSessionId) {
    context.sessionId = extractors.getSessionId(req);
  } else {
    // Try to get from request or session
    const rateLimitedReq = req as RateLimitedRequest;
    context.sessionId =
      rateLimitedReq.sessionId ?? (req as Request & { sessionID?: string }).sessionID;
  }

  // Extract user ID
  if (extractors.getUserId) {
    context.userId = extractors.getUserId(req);
  } else {
    const rateLimitedReq = req as RateLimitedRequest;
    context.userId = rateLimitedReq.userId;
  }

  return context;
}

// Import prom-client for metrics (optional dependency)
import * as promClient from 'prom-client';

/**
 * Create metrics collectors using prom-client.
 */
function createMetrics(): RateLimiterMetrics {
  const requestCounter = new promClient.Counter({
    name: 'rate_limiter_requests_total',
    help: 'Total number of rate limit checks',
    labelNames: ['action', 'outcome'] as const,
  });

  const latencyHistogram = new promClient.Histogram({
    name: 'rate_limiter_check_duration_ms',
    help: 'Duration of rate limit checks in milliseconds',
    labelNames: ['action'] as const,
    buckets: [0.1, 0.5, 1, 2, 5, 10, 25, 50, 100],
  });

  const storeSizeGauge = new promClient.Gauge({
    name: 'rate_limiter_store_size',
    help: 'Current number of entries in the rate limit store',
  });

  return {
    incRequests(action, outcome) {
      requestCounter.inc({ action, outcome });
    },
    observeLatency(action, durationMs) {
      latencyHistogram.observe({ action }, durationMs);
    },
    setStoreSize(size) {
      storeSizeGauge.set(size);
    },
  };
}

/**
 * Create a simple middleware that just checks rate limit and attaches decision.
 * Does not automatically return 429 - allows custom handling.
 *
 * @param options - Rate limiter configuration
 * @returns Middleware factory
 */
export function createPassiveRateLimiter(options: RateLimiterMiddlewareOptions): {
  forAction: (actionOptions: ActionMiddlewareOptions) => RequestHandler;
  engine: PolicyEngine;
  shutdown: () => Promise<void>;
} {
  const { store, policies, onDecision, logger, hashSecret } = options;

  const engine = new PolicyEngine({
    store,
    policies,
    keyExtractor: options.keyExtractor,
    logger,
  });

  function forAction(actionOptions: ActionMiddlewareOptions): RequestHandler {
    const { action, getEmail, getPhone, getSessionId, getUserId, skip } = actionOptions;

    const asyncHandler = async (
      req: Request,
      _res: Response,
      next: NextFunction
    ): Promise<void> => {
      try {
        if (skip?.(req)) {
          next();
          return;
        }

        const context = buildRequestContext(
          req,
          action,
          { getEmail, getPhone, getSessionId, getUserId },
          hashSecret,
          logger
        );

        const decision = await engine.check(context);
        (req as RateLimitedRequest).rateLimitDecision = decision;

        onDecision?.(decision);

        // Always call next - let the route handler decide what to do
        next();
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger?.error({ action, error: err.message }, 'Passive rate limiter error');
        next();
      }
    };

    return (req: Request, res: Response, next: NextFunction): void => {
      asyncHandler(req, res, next).catch(next);
    };
  }

  async function shutdown(): Promise<void> {
    await store.shutdown();
  }

  return {
    forAction,
    engine,
    shutdown,
  };
}
