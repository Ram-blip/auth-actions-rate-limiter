/**
 * Express Demo Server
 *
 * Demonstrates the auth-action-rate-limiter with a simple Express app.
 *
 * IMPORTANT: This demo uses in-process rate limiting.
 * For production deployments with multiple instances,
 * use an external store like Redis.
 *
 * Endpoints:
 * - POST /auth/password-reset/request - Password reset (enumeration-safe)
 * - POST /auth/register - User registration
 * - POST /auth/login - User login
 * - POST /auth/otp/send - Send OTP
 * - POST /auth/otp/verify - Verify OTP
 * - GET /auth/rate-limit-status - Debug status
 * - GET /health - Health check
 * - GET /metrics - Prometheus metrics (if enabled)
 */

import express from 'express';
import pino from 'pino';
import * as promClient from 'prom-client';
import { authRouter } from './routes/auth.js';

// Create logger
const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true },
  },
});

// Create Express app
const app = express();

// Middleware
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info(
      {
        method: req.method,
        url: req.url,
        status: res.statusCode,
        duration: Date.now() - start,
        ip: req.ip,
      },
      'Request completed'
    );
  });
  next();
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auth routes (with rate limiting)
app.use('/auth', authRouter);

// Prometheus metrics (optional)
if (process.env.ENABLE_METRICS === 'true') {
  promClient.collectDefaultMetrics();

  app.get('/metrics', (_req, res) => {
    void (async () => {
      res.set('Content-Type', promClient.register.contentType);
      res.send(await promClient.register.metrics());
    })();
  });
}

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ error: err.message, stack: err.stack }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
const PORT = parseInt(process.env.PORT ?? '3000', 10);

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Server started');
  logger.info('Available endpoints:');
  logger.info('  POST /auth/password-reset/request - Request password reset');
  logger.info('  POST /auth/register - Register new user');
  logger.info('  POST /auth/login - Login');
  logger.info('  POST /auth/otp/send - Send OTP');
  logger.info('  POST /auth/otp/verify - Verify OTP');
  logger.info('  GET /auth/rate-limit-status - Check rate limiter status');
  logger.info('  GET /health - Health check');
  if (process.env.ENABLE_METRICS === 'true') {
    logger.info('  GET /metrics - Prometheus metrics');
  }
  logger.info('');
  logger.info('Test with:');
  logger.info(`  curl -X POST http://localhost:${PORT}/auth/password-reset/request \\`);
  logger.info('    -H "Content-Type: application/json" \\');
  logger.info('    -d \'{"email": "test@example.com"}\'');
});

export { app };
