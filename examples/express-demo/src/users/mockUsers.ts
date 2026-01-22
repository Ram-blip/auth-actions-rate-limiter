/**
 * Mock Users Database
 *
 * This is a simple in-memory mock for demonstration purposes.
 * In a real application, this would be a database.
 */

export interface User {
  id: string;
  email: string;
  phone?: string;
  passwordHash: string;
  otpSecret?: string;
  createdAt: Date;
}

/**
 * Mock user database.
 */
const users: Map<string, User> = new Map([
  [
    'user-1',
    {
      id: 'user-1',
      email: 'alice@example.com',
      phone: '+1234567890',
      passwordHash: 'hashed_password_1',
      createdAt: new Date('2024-01-01'),
    },
  ],
  [
    'user-2',
    {
      id: 'user-2',
      email: 'bob@example.com',
      passwordHash: 'hashed_password_2',
      createdAt: new Date('2024-02-01'),
    },
  ],
]);

/**
 * Find a user by email.
 */
export function findUserByEmail(email: string): User | undefined {
  const normalizedEmail = email.toLowerCase().trim();
  for (const user of users.values()) {
    if (user.email.toLowerCase() === normalizedEmail) {
      return user;
    }
  }
  return undefined;
}

/**
 * Find a user by ID.
 */
export function findUserById(id: string): User | undefined {
  return users.get(id);
}

/**
 * Create a new user.
 */
export function createUser(email: string, passwordHash: string, phone?: string): User {
  const id = `user-${Date.now()}`;
  const user: User = {
    id,
    email: email.toLowerCase().trim(),
    phone,
    passwordHash,
    createdAt: new Date(),
  };
  users.set(id, user);
  return user;
}

/**
 * Check if an email is already registered.
 */
export function emailExists(email: string): boolean {
  return findUserByEmail(email) !== undefined;
}

/**
 * Verify password (mock implementation).
 */
export function verifyPassword(_user: User, _password: string): boolean {
  // In a real app, this would use bcrypt or similar
  // For demo, always return true if user exists
  return true;
}

/**
 * Generate and store OTP for a user.
 */
const otpStore: Map<string, { code: string; expiresAt: number }> = new Map();

export function generateOtp(userId: string): string {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore.set(userId, {
    code,
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
  });
  return code;
}

/**
 * Verify OTP for a user.
 */
export function verifyOtp(userId: string, code: string): boolean {
  const stored = otpStore.get(userId);
  if (!stored) {
    return false;
  }

  if (Date.now() > stored.expiresAt) {
    otpStore.delete(userId);
    return false;
  }

  if (stored.code === code) {
    otpStore.delete(userId);
    return true;
  }

  return false;
}

/**
 * Session store (mock).
 */
const sessions: Map<string, { userId?: string; createdAt: number }> = new Map();

export function createSession(): string {
  const sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(2)}`;
  sessions.set(sessionId, { createdAt: Date.now() });
  return sessionId;
}

export function getSession(sessionId: string): { userId?: string; createdAt: number } | undefined {
  return sessions.get(sessionId);
}

export function setSessionUser(sessionId: string, userId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.userId = userId;
  }
}
