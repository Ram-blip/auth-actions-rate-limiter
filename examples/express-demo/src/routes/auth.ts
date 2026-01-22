/**
 * Auth Routes Demo
 *
 * Demonstrates how to use the rate limiter with common auth endpoints.
 * Pay attention to the enumeration-safe responses for password reset.
 */

import { Router, Request, Response } from 'express';
import {
  createRateLimiter,
  MemoryStore,
  defaultPolicies,
  RateLimitedRequest,
} from '../../../../src/index.js';
import {
  findUserByEmail,
  createUser,
  emailExists,
  verifyPassword,
  generateOtp,
  verifyOtp,
  createSession,
  getSession,
  setSessionUser,
} from '../users/mockUsers.js';
import pino from 'pino';

// Create logger
const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true },
  },
});

// Create the memory store
const store = new MemoryStore(
  {
    sweepIntervalMs: 30_000, // Sweep every 30 seconds
    highWaterMark: 10_000, // Max 10k entries for demo
  },
  logger
);

// Create the rate limiter
const rateLimiter = createRateLimiter({
  store,
  policies: defaultPolicies,
  hashSecret: process.env.HASH_SECRET ?? 'demo-secret-change-in-production',
  logger,
  onDecision: (decision) => {
    if (!decision.allowed) {
      logger.warn(
        {
          action: decision.action,
          outcome: decision.outcome,
          retryAfterMs: decision.retryAfterMs,
        },
        'Rate limit triggered'
      );
    }
  },
});

// Create router
const router = Router();

/**
 * POST /auth/password-reset/request
 *
 * IMPORTANT: This endpoint demonstrates enumeration-safe responses.
 * We ALWAYS return the same success message, regardless of whether
 * the email exists in our database. This prevents attackers from
 * discovering valid email addresses through the password reset flow.
 */
router.post(
  '/password-reset/request',
  rateLimiter.forAction({
    action: 'password_reset_request',
    getEmail: (req: Request) => (req.body as { email?: string }).email,
  }),
  (req: Request, res: Response) => {
    const { email } = req.body as { email?: string };

    if (!email) {
      res.status(400).json({ error: 'Email is required' });
      return;
    }

    // Look up user (but don't reveal if they exist)
    const user = findUserByEmail(email);

    if (user) {
      // In a real app: send password reset email
      logger.info({ userId: user.id }, 'Password reset email sent (simulated)');
    } else {
      // User doesn't exist - but we don't tell them that!
      logger.debug({ email: '***' }, 'Password reset requested for non-existent email');
    }

    // ENUMERATION-SAFE: Always return the same response
    res.json({
      message: 'If an account exists with this email, you will receive a password reset link.',
    });
  }
);

/**
 * POST /auth/register
 *
 * Registration endpoint with rate limiting.
 * Uses 'open' fail mode because blocking legitimate users is worse
 * than allowing a few extra registrations.
 */
router.post(
  '/register',
  rateLimiter.forAction({
    action: 'register',
    getEmail: (req: Request) => (req.body as { email?: string }).email,
  }),
  (req: Request, res: Response) => {
    const { email, password, phone } = req.body as {
      email?: string;
      password?: string;
      phone?: string;
    };

    // Check if challenge is required (from rate limiter)
    const decision = (req as RateLimitedRequest).rateLimitDecision;
    if (decision?.outcome === 'CHALLENGE') {
      res.status(428).json({
        error: 'CHALLENGE_REQUIRED',
        challenge: decision.challenge ?? 'captcha_required',
        message: 'Please complete the captcha to continue registration.',
      });
      return;
    }

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    if (emailExists(email)) {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }

    // Create user (in real app: hash password)
    const user = createUser(email, password, phone);
    const sessionId = createSession();
    setSessionUser(sessionId, user.id);

    logger.info({ userId: user.id }, 'User registered');

    res.status(201).json({
      message: 'Registration successful',
      user: {
        id: user.id,
        email: user.email,
      },
      sessionId,
    });
  }
);

/**
 * POST /auth/login
 *
 * Login endpoint with rate limiting.
 */
router.post(
  '/login',
  rateLimiter.forAction({
    action: 'login',
    getEmail: (req: Request) => (req.body as { email?: string }).email,
  }),
  (req: Request, res: Response) => {
    const { email, password } = req.body as { email?: string; password?: string };

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const user = findUserByEmail(email);

    if (!user || !verifyPassword(user, password)) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const sessionId = createSession();
    setSessionUser(sessionId, user.id);

    logger.info({ userId: user.id }, 'User logged in');

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
      },
      sessionId,
    });
  }
);

/**
 * POST /auth/otp/send
 *
 * Send OTP to user's phone. Rate limited by session and IP.
 */
router.post(
  '/otp/send',
  rateLimiter.forAction({
    action: 'otp_send',
    getSessionId: (req: Request) => req.headers['x-session-id'] as string | undefined,
    getPhone: (req: Request) => (req.body as { phone?: string }).phone,
  }),
  (req: Request, res: Response) => {
    const sessionId = req.headers['x-session-id'] as string | undefined;

    if (!sessionId) {
      res.status(400).json({ error: 'Session ID required (X-Session-ID header)' });
      return;
    }

    const session = getSession(sessionId);
    if (!session?.userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // Generate and "send" OTP
    const otp = generateOtp(session.userId);

    // In a real app, send via SMS/email
    logger.info({ userId: session.userId, otp }, 'OTP generated (shown for demo)');

    res.json({
      message: 'OTP sent successfully',
      // In real app, don't include OTP in response!
      // Only shown here for demo purposes
      _demo_otp: otp,
    });
  }
);

/**
 * POST /auth/otp/verify
 *
 * Verify OTP. Rate limited by session to prevent brute force.
 */
router.post(
  '/otp/verify',
  rateLimiter.forAction({
    action: 'otp_verify',
    getSessionId: (req: Request) => req.headers['x-session-id'] as string | undefined,
  }),
  (req: Request, res: Response) => {
    const sessionId = req.headers['x-session-id'] as string | undefined;
    const { code } = req.body as { code?: string };

    if (!sessionId) {
      res.status(400).json({ error: 'Session ID required (X-Session-ID header)' });
      return;
    }

    if (!code) {
      res.status(400).json({ error: 'OTP code is required' });
      return;
    }

    const session = getSession(sessionId);
    if (!session?.userId) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    if (!verifyOtp(session.userId, code)) {
      res.status(401).json({ error: 'Invalid or expired OTP' });
      return;
    }

    logger.info({ userId: session.userId }, 'OTP verified successfully');

    res.json({
      message: 'OTP verified successfully',
      verified: true,
    });
  }
);

/**
 * GET /auth/rate-limit-status
 *
 * Debug endpoint to check rate limiter status.
 * In production, this should be protected or removed.
 */
router.get('/rate-limit-status', async (_req: Request, res: Response) => {
  const storeSize = await store.size();
  const stats = store.getStats();

  res.json({
    storeSize,
    ...stats,
    policies: Object.keys(defaultPolicies),
  });
});

// Cleanup on process exit
process.on('SIGTERM', async () => {
  logger.info('Shutting down rate limiter...');
  await rateLimiter.shutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Shutting down rate limiter...');
  await rateLimiter.shutdown();
  process.exit(0);
});

export { router as authRouter, store, rateLimiter };
