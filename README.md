# auth-action-rate-limiter

A modular, policy-driven, **in-process** rate limiter for Node.js, designed for abuse prevention in sensitive authentication flows like password reset, registration, and OTP verification.

[![CI](https://github.com/yourusername/auth-action-rate-limiter/actions/workflows/ci.yml/badge.svg)](https://github.com/yourusername/auth-action-rate-limiter/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## ⚠️ Important: In-Process Only

**This library provides rate limiting within a single Node.js process.** Rate limits are NOT shared across multiple instances, containers, or servers.

For distributed rate limiting across multiple instances, you need an external shared store like Redis. This library is intentionally designed for:

- Single-instance deployments
- Development and testing environments
- Prototyping and early-stage projects
- Scenarios where a gateway/WAF handles distributed rate limiting

## Table of Contents

- [Why Rate Limit Auth Flows?](#why-rate-limit-auth-flows)
- [Features](#features)
- [Installation](#installation)
- [Quickstart](#quickstart)
- [Configuration](#configuration)
- [Default Policies](#default-policies)
- [API Reference](#api-reference)
- [Security Considerations](#security-considerations)
- [Fail-Open vs Fail-Closed](#fail-open-vs-fail-closed)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Examples](#examples)
- [Contributing](#contributing)
- [License](#license)

## Why Rate Limit Auth Flows?

Authentication endpoints are prime targets for abuse:

| Attack | Target | Impact |
|--------|--------|--------|
| Credential stuffing | Login | Account takeover |
| Brute force | Login, OTP verify | Account compromise |
| Account enumeration | Password reset, Registration | User discovery |
| SMS/Email bombing | OTP send | Cost, user annoyance |
| Registration spam | Registration | Database pollution |

Rate limiting these endpoints reduces attack surface and protects both users and infrastructure.

## Features

- 🪣 **Token Bucket Algorithm** - Allows bursts while maintaining average rate limits
- 📋 **Policy-Driven** - Configure rules per action with JSON/objects
- 🔗 **AND Semantics** - Multiple rules per action, all must pass
- 🔐 **Security-First** - HMAC hashing for identifiers, enumeration-safe patterns
- ⚡ **Challenge Mode** - Step-up authentication (captcha) instead of hard blocks
- 📊 **Observability** - Structured logging (pino), Prometheus metrics support
- 🧪 **Well Tested** - Comprehensive unit tests with deterministic time control
- 📦 **Zero External Dependencies** - No Redis, no external services required

## Installation

```bash
npm install @ramblip/auth-action-rate-limiter
```

Peer dependencies:
```bash
npm install express  # If using Express middleware
```

## Quickstart

```typescript
import express from 'express';
import {
  createRateLimiter,
  MemoryStore,
  defaultPolicies,
} from '@ramblip/auth-action-rate-limiter';

const app = express();
app.use(express.json());

// Create the rate limiter
const store = new MemoryStore();
const rateLimiter = createRateLimiter({
  store,
  policies: defaultPolicies,
  hashSecret: process.env.HASH_SECRET || 'change-me-in-production',
});

// Apply to password reset endpoint
app.post('/auth/password-reset/request',
  rateLimiter.forAction({
    action: 'password_reset_request',
    getEmail: (req) => req.body.email,
  }),
  (req, res) => {
    // IMPORTANT: Always return same response to prevent enumeration
    res.json({
      message: 'If an account exists, you will receive a reset email.',
    });
  }
);

// Apply to registration endpoint
app.post('/auth/register',
  rateLimiter.forAction({
    action: 'register',
    getEmail: (req) => req.body.email,
  }),
  (req, res) => {
    // Check if challenge is required
    if (req.rateLimitDecision?.outcome === 'CHALLENGE') {
      return res.status(428).json({
        error: 'CHALLENGE_REQUIRED',
        challenge: 'captcha_required',
      });
    }
    // ... registration logic
  }
);

// Clean shutdown
process.on('SIGTERM', async () => {
  await rateLimiter.shutdown();
  process.exit(0);
});

app.listen(3000);
```

## Configuration

### ActionPolicy

```typescript
interface ActionPolicy {
  id: string;                    // Action identifier
  rules: RateLimitRule[];        // Array of rules (AND semantics)
  failMode: 'open' | 'closed';   // Behavior on store errors
}
```

### RateLimitRule

```typescript
interface RateLimitRule {
  name: string;                  // Rule identifier
  key: KeyDimension[];           // Dimensions for rate limit key
  capacity: number;              // Burst capacity (max tokens)
  refillTokens: number;          // Tokens added per interval
  refillIntervalMs: number;      // Refill interval in ms
  cost?: number;                 // Tokens per request (default: 1)
  mode?: 'block' | 'challenge';  // What to do when exceeded
  ttlMs?: number;                // TTL for stored state
}
```

### Key Dimensions

| Dimension | Description |
|-----------|-------------|
| `ip` | Client IP address |
| `emailHash` | HMAC-hashed email |
| `phoneHash` | HMAC-hashed phone |
| `userId` | Authenticated user ID |
| `sessionId` | Session identifier |
| `action` | Action name |
| `route` | Request path |

### Custom Policy Example

```typescript
import { ActionPolicy, TIME } from '@ramblip/auth-action-rate-limiter';

const customPasswordResetPolicy: ActionPolicy = {
  id: 'password_reset_request',
  rules: [
    {
      name: 'per_ip',
      key: ['ip'],
      capacity: 10,           // 10 requests burst
      refillTokens: 10,       // Refill all 10
      refillIntervalMs: TIME.MINUTE, // Every minute
      mode: 'block',
    },
    {
      name: 'per_email',
      key: ['emailHash'],
      capacity: 3,            // 3 per email
      refillTokens: 3,
      refillIntervalMs: TIME.MINUTE * 15,
      mode: 'block',
    },
  ],
  failMode: 'closed',         // Security > availability
};
```

## Default Policies

The library includes sensible defaults for common auth endpoints:

### password_reset_request
- **per_ip**: 5 requests/minute
- **per_email**: 3 requests/15 minutes
- **failMode**: closed

### register
- **per_ip**: 10 requests/hour
- **per_ip_email**: 3 requests/hour (challenge mode)
- **failMode**: open

### login
- **per_ip**: 20 requests/hour
- **per_ip_email**: 5 requests/15 minutes
- **failMode**: closed

### otp_send
- **per_session**: 3 requests/10 minutes
- **per_ip**: 10 requests/hour
- **failMode**: closed

### otp_verify
- **per_session**: 5 attempts/10 minutes
- **failMode**: closed

## API Reference

### createRateLimiter(options)

Creates the rate limiter middleware factory.

```typescript
const rateLimiter = createRateLimiter({
  store: RateLimitStore,           // Required: store instance
  policies: Record<string, ActionPolicy>, // Required: policy config
  hashSecret?: string,             // Secret for HMAC hashing
  logger?: Logger,                 // Pino-compatible logger
  onDecision?: (decision) => void, // Decision callback
  enableMetrics?: boolean,         // Enable Prometheus metrics
});
```

### rateLimiter.forAction(options)

Creates middleware for a specific action.

```typescript
app.post('/endpoint',
  rateLimiter.forAction({
    action: 'action_name',         // Must match policy ID
    getEmail?: (req) => string,    // Extract email from request
    getPhone?: (req) => string,    // Extract phone from request
    getSessionId?: (req) => string,// Extract session ID
    getUserId?: (req) => string,   // Extract user ID
    skip?: (req) => boolean,       // Skip rate limiting
  }),
  handler
);
```

### MemoryStore

In-process rate limit store.

```typescript
const store = new MemoryStore({
  sweepIntervalMs?: number,  // Cleanup interval (default: 60000)
  highWaterMark?: number,    // Max entries (default: 100000)
  evictionCount?: number,    // Entries to evict (default: 10000)
});

// Get stats
const stats = store.getStats();
// { size, highWaterMark, utilizationPercent }

// Clean shutdown
await store.shutdown();
```

### Hash Utilities

```typescript
import { hashIdentifier, hashEmail, hashPhone } from '@ramblip/auth-action-rate-limiter';

// Hash any identifier
const hash = hashIdentifier('user@example.com', secret);

// Specialized hashers
const emailHash = hashEmail('user@example.com', secret);
const phoneHash = hashPhone('+1-234-567-8900', secret);
```

## Security Considerations

### Account Enumeration Prevention

For password reset, **always return the same response** regardless of whether the email exists:

```typescript
app.post('/auth/password-reset/request', rateLimiter, (req, res) => {
  const user = await findUserByEmail(req.body.email);
  
  if (user) {
    await sendPasswordResetEmail(user);
  }
  // Log for internal monitoring, but don't expose to user
  
  // ALWAYS same response
  res.json({
    message: 'If an account exists with this email, you will receive a reset link.',
  });
});
```

### Identifier Hashing

Never store raw emails or phone numbers in rate limit keys:

```typescript
// ❌ Bad - leaks PII if store is compromised
const key = `rate:${email}`;

// ✅ Good - uses HMAC hash
const key = `rate:${hashEmail(email, secret)}`;
```

The library handles this automatically when you use `getEmail` and `getPhone` extractors with a `hashSecret`.

### Proxy IP Handling

If behind a reverse proxy, ensure proper IP extraction:

```typescript
// Trust first IP in X-Forwarded-For
app.set('trust proxy', 1);

// Or configure custom extraction
rateLimiter.forAction({
  action: 'login',
  // Custom IP extraction if needed
});
```

## Fail-Open vs Fail-Closed

| Mode | Behavior | Use When |
|------|----------|----------|
| **fail-closed** | Block on errors | Security critical (password reset, OTP) |
| **fail-open** | Allow on errors | Availability critical (registration) |

### When to use fail-closed:
- Password reset requests
- OTP verification
- Login attempts
- Any action where false negatives are dangerous

### When to use fail-open:
- Registration (blocking legitimate users is worse than allowing some spam)
- Non-critical actions
- When a gateway/WAF provides backup rate limiting

## Troubleshooting

### High Memory Usage

Check store utilization:
```typescript
const stats = store.getStats();
console.log(`Store: ${stats.size}/${stats.highWaterMark} (${stats.utilizationPercent}%)`);
```

Tune the high water mark:
```typescript
const store = new MemoryStore({
  highWaterMark: 50_000,    // Reduce max entries
  evictionCount: 5_000,     // Evict more per trigger
  sweepIntervalMs: 30_000,  // Sweep more frequently
});
```

### Requests Not Being Limited

1. **Check action ID matches policy**:
```typescript
rateLimiter.forAction({ action: 'password_reset_request' }) // Must match policy
```

2. **Verify dimensions are available**:
```typescript
// If rule uses emailHash, email must be provided
rateLimiter.forAction({
  action: 'password_reset_request',
  getEmail: (req) => req.body.email,  // Required!
});
```

3. **Check IP extraction** (behind proxy):
```typescript
app.set('trust proxy', true);
```

### Limits Too Aggressive/Lenient

Adjust policy configuration:
```typescript
const policies = customizePolicies({
  password_reset_request: {
    rules: [
      {
        name: 'per_ip',
        key: ['ip'],
        capacity: 20,           // More lenient
        refillTokens: 20,
        refillIntervalMs: TIME.MINUTE,
      },
    ],
  },
});
```

## Limitations

1. **In-Process Only**: Not suitable for multi-instance deployments without shared storage
2. **Memory Bound**: All state is in memory; restart clears limits
3. **No Persistence**: Rate limits don't survive process restarts
4. **Single Process**: Cannot coordinate limits across cluster workers

### For Production Multi-Instance Deployments

Consider:
- API Gateway rate limiting (AWS API Gateway, Kong, etc.)
- WAF rules (CloudFlare, AWS WAF)
- Redis-backed rate limiter (not included in this library)
- Distributed rate limiting service

## Examples

See the [examples/express-demo](./examples/express-demo) directory for a complete working example with:

- Password reset (enumeration-safe)
- User registration with challenge mode
- Login with rate limiting
- OTP send/verify flow

Run the demo:
```bash
npm run dev
```

Test rate limiting:
```bash
# Password reset (will hit limit after 5 requests)
for i in {1..10}; do
  curl -X POST http://localhost:3000/auth/password-reset/request \
    -H "Content-Type: application/json" \
    -d '{"email": "test@example.com"}'
  echo
done
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Run tests (`npm test`)
4. Run linter (`npm run lint`)
5. Commit your changes (`git commit -m 'Add amazing feature'`)
6. Push to the branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

## License

MIT License - see [LICENSE](./LICENSE) for details.

---

**Note**: This library is designed for in-process rate limiting. For production deployments with multiple instances, implement distributed rate limiting using Redis or similar, or rely on infrastructure-level rate limiting (API Gateway, WAF, etc.).
