/**
 * Time utilities for rate limiting.
 *
 * These utilities provide consistent time handling across the library.
 * Using a centralized time source makes testing with fake timers easier.
 */

/**
 * Interface for a time provider.
 * Allows for dependency injection of time for testing.
 */
export interface TimeProvider {
  /** Get the current time in milliseconds since epoch */
  now(): number;
}

/**
 * Default time provider using Date.now().
 */
export const defaultTimeProvider: TimeProvider = {
  now: () => Date.now(),
};

/**
 * Create a mock time provider for testing.
 * Allows manual control of time progression.
 *
 * @param initialTime - Initial time value (defaults to Date.now())
 * @returns A mock time provider with advance capabilities
 */
export function createMockTimeProvider(initialTime: number = Date.now()): TimeProvider & {
  advance: (ms: number) => void;
  set: (time: number) => void;
} {
  let currentTime = initialTime;

  return {
    now: () => currentTime,
    advance: (ms: number) => {
      currentTime += ms;
    },
    set: (time: number) => {
      currentTime = time;
    },
  };
}

/**
 * Convert milliseconds to seconds, rounding up.
 * Used for HTTP Retry-After header.
 *
 * @param ms - Milliseconds
 * @returns Seconds (rounded up)
 */
export function msToSeconds(ms: number): number {
  return Math.ceil(ms / 1000);
}

/**
 * Time constants for convenience.
 */
export const TIME = {
  SECOND: 1000,
  MINUTE: 60 * 1000,
  HOUR: 60 * 60 * 1000,
  DAY: 24 * 60 * 60 * 1000,
} as const;

/**
 * Parse a human-readable duration string to milliseconds.
 *
 * @param duration - Duration string (e.g., '5m', '1h', '30s')
 * @returns Duration in milliseconds
 *
 * @example
 * ```typescript
 * parseDuration('5m')  // 300000
 * parseDuration('1h')  // 3600000
 * parseDuration('30s') // 30000
 * ```
 */
export function parseDuration(duration: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(duration.trim().toLowerCase());

  if (!match) {
    throw new Error(
      `Invalid duration format: ${duration}. Expected format: <number><unit> (e.g., 5m, 1h, 30s)`
    );
  }

  const value = parseInt(match[1] ?? '0', 10);
  const unit = match[2];

  switch (unit) {
    case 's':
      return value * TIME.SECOND;
    case 'm':
      return value * TIME.MINUTE;
    case 'h':
      return value * TIME.HOUR;
    case 'd':
      return value * TIME.DAY;
    default:
      throw new Error(`Unknown time unit: ${unit}`);
  }
}
