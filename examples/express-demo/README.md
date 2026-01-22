# Express Demo Application

This is a demonstration application showing how to use the `auth-action-rate-limiter` library with Express.

## ⚠️ Important Note

This demo uses **in-process rate limiting** via `MemoryStore`. This means:

- Rate limits are **not shared** between multiple Node.js processes
- If you restart the server, all rate limit state is lost
- For production with multiple instances, use an external store like Redis

## Running the Demo

From the repository root:

```bash
# Install dependencies
npm install

# Start the demo server
npm run dev
```

The server starts on port 3000 (or `PORT` environment variable).

## Available Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/auth/password-reset/request` | POST | Request password reset (enumeration-safe) |
| `/auth/register` | POST | Register a new user |
| `/auth/login` | POST | Login with email/password |
| `/auth/otp/send` | POST | Send OTP (requires session) |
| `/auth/otp/verify` | POST | Verify OTP (requires session) |
| `/auth/rate-limit-status` | GET | Debug rate limiter status |
| `/health` | GET | Health check |
| `/metrics` | GET | Prometheus metrics (if enabled) |

## Testing Rate Limits

### Password Reset (Enumeration-Safe)

```bash
# First few requests succeed
curl -X POST http://localhost:3000/auth/password-reset/request \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com"}'

# After 5 requests from same IP or 3 for same email, you'll get 429
# Note: Response is always the same to prevent email enumeration!
```

**Key Security Feature**: The response is always "If an account exists with this email, you will receive a password reset link" - regardless of whether the email exists in the database. This prevents attackers from discovering valid email addresses.

### Registration with Challenge

```bash
# Register a user
curl -X POST http://localhost:3000/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "newuser@example.com", "password": "secure123"}'

# After 3 attempts for same email from same IP, you'll get a challenge response (428)
```

### Login

```bash
# Login (existing test users: alice@example.com, bob@example.com)
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "alice@example.com", "password": "password123"}'
```

### OTP Flow

```bash
# First login to get a session
SESSION=$(curl -s -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "alice@example.com", "password": "password123"}' | jq -r '.sessionId')

# Send OTP (limited to 3 per 10 minutes per session)
curl -X POST http://localhost:3000/auth/otp/send \
  -H "Content-Type: application/json" \
  -H "X-Session-ID: $SESSION"

# Verify OTP (limited to 5 attempts per 10 minutes per session)
curl -X POST http://localhost:3000/auth/otp/verify \
  -H "Content-Type: application/json" \
  -H "X-Session-ID: $SESSION" \
  -d '{"code": "123456"}'
```

## Rate Limit Responses

When rate limited, you'll receive a 429 response:

```json
{
  "error": "RATE_LIMITED",
  "action": "password_reset_request",
  "retryAfterMs": 60000,
  "outcome": "BLOCKED"
}
```

The `Retry-After` header is also set (in seconds).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `LOG_LEVEL` | info | Pino log level |
| `HASH_SECRET` | demo-secret-... | HMAC secret for hashing emails |
| `ENABLE_METRICS` | false | Enable Prometheus metrics |

## Rate Limit Policies

The demo uses the default policies from the library:

- **password_reset_request**: 5/min per IP, 3/15min per email, fail-closed
- **register**: 10/hour per IP, 3/hour per IP+email (challenge mode), fail-open
- **login**: 20/hour per IP, 5/15min per IP+email, fail-closed
- **otp_send**: 3/10min per session, 10/hour per IP, fail-closed
- **otp_verify**: 5/10min per session, fail-closed

## Architecture Notes

```
┌─────────────────────────────────────────────────────────────┐
│                     Express Server                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Request → Rate Limiter Middleware → Route Handler          │
│               │                                             │
│               ▼                                             │
│        ┌──────────────┐                                     │
│        │ PolicyEngine │                                     │
│        └──────┬───────┘                                     │
│               │                                             │
│               ▼                                             │
│        ┌──────────────┐                                     │
│        │ MemoryStore  │  (In-Process Only!)                 │
│        │   (Map)      │                                     │
│        └──────────────┘                                     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

For multi-instance deployments, replace `MemoryStore` with a Redis-backed store (not included in this library - documented as future work).
