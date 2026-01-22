/**
 * In-Process Memory Store for Rate Limiting
 *
 * IMPORTANT: This store is designed for single-process rate limiting only.
 * It does NOT provide distributed rate limiting across multiple Node.js instances.
 *
 * For distributed rate limiting, use an external store like Redis.
 * This is documented as a limitation - see README.md.
 *
 * Features:
 * - Efficient Map-based storage
 * - TTL-based expiration with lazy eviction on access
 * - Periodic sweeping to reclaim memory from expired entries
 * - High water mark to bound memory usage
 * - Single sweeper timer (not per-key timers)
 */

import type {
  RateLimitStore,
  TokenBucketState,
  MemoryStoreOptions,
  Logger,
} from '../core/types.js';

/**
 * Internal entry structure with metadata for management.
 */
interface StoreEntry {
  /** The bucket state */
  state: TokenBucketState;

  /** Last access time for LRU-like eviction */
  lastAccessedAt: number;
}

/**
 * Default options for MemoryStore.
 */
const DEFAULT_OPTIONS: Required<MemoryStoreOptions> = {
  sweepIntervalMs: 60_000, // 1 minute
  highWaterMark: 100_000, // 100k entries
  evictionCount: 10_000, // 10% of high water mark
};

/**
 * In-process memory store for rate limiting.
 *
 * @example
 * ```typescript
 * const store = new MemoryStore({
 *   sweepIntervalMs: 30_000,  // Sweep every 30 seconds
 *   highWaterMark: 50_000,    // Max 50k entries
 * });
 *
 * // Use with rate limiter...
 *
 * // Clean up on shutdown
 * process.on('SIGTERM', () => store.shutdown());
 * ```
 */
export class MemoryStore implements RateLimitStore {
  private readonly store: Map<string, StoreEntry>;
  private readonly options: Required<MemoryStoreOptions>;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private isShutdown = false;
  private readonly logger?: Logger;

  constructor(options: MemoryStoreOptions = {}, logger?: Logger) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.store = new Map();
    this.logger = logger;

    // Start the periodic sweeper
    this.startSweeper();
  }

  /**
   * Get a bucket state by key.
   * Performs lazy expiration check - returns undefined if expired.
   */
  async get(key: string): Promise<TokenBucketState | undefined> {
    this.checkShutdown();

    const entry = this.store.get(key);

    if (!entry) {
      return undefined;
    }

    const now = Date.now();

    // Lazy expiration check
    if (now >= entry.state.expiresAt) {
      this.store.delete(key);
      this.logger?.debug({ key, reason: 'expired' }, 'Entry evicted on access');
      return undefined;
    }

    // Update last accessed time
    entry.lastAccessedAt = now;

    return entry.state;
  }

  /**
   * Set/update a bucket state.
   * Enforces high water mark limit.
   */
  async set(key: string, state: TokenBucketState, _ttlMs: number): Promise<void> {
    this.checkShutdown();

    const now = Date.now();
    const existingEntry = this.store.get(key);

    if (existingEntry) {
      // Update existing entry
      existingEntry.state = state;
      existingEntry.lastAccessedAt = now;
    } else {
      // Check high water mark before adding new entry
      if (this.store.size >= this.options.highWaterMark) {
        this.evictEntries();
      }

      // Add new entry
      this.store.set(key, {
        state,
        lastAccessedAt: now,
      });
    }
  }

  /**
   * Delete a bucket entry.
   */
  async delete(key: string): Promise<void> {
    this.checkShutdown();
    this.store.delete(key);
  }

  /**
   * Check if a key exists and is not expired.
   */
  async has(key: string): Promise<boolean> {
    this.checkShutdown();

    const entry = this.store.get(key);

    if (!entry) {
      return false;
    }

    // Check expiration
    if (Date.now() >= entry.state.expiresAt) {
      this.store.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Get the current size of the store.
   * Note: May include some expired entries that haven't been swept yet.
   */
  async size(): Promise<number> {
    this.checkShutdown();
    return this.store.size;
  }

  /**
   * Clear all entries from the store.
   */
  async clear(): Promise<void> {
    this.checkShutdown();
    this.store.clear();
    this.logger?.info({}, 'Store cleared');
  }

  /**
   * Shutdown the store.
   * Stops the sweeper timer and clears all entries.
   */
  async shutdown(): Promise<void> {
    if (this.isShutdown) {
      return;
    }

    this.isShutdown = true;

    // Stop the sweeper
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }

    // Clear the store
    this.store.clear();

    this.logger?.info({}, 'Memory store shutdown complete');
  }

  /**
   * Start the periodic sweeper.
   */
  private startSweeper(): void {
    if (this.options.sweepIntervalMs <= 0) {
      return;
    }

    this.sweepTimer = setInterval(() => {
      this.sweep();
    }, this.options.sweepIntervalMs);

    // Don't prevent process exit
    if (this.sweepTimer.unref) {
      this.sweepTimer.unref();
    }
  }

  /**
   * Sweep expired entries from the store.
   */
  private sweep(): void {
    if (this.isShutdown) {
      return;
    }

    const now = Date.now();
    let evictedCount = 0;

    for (const [key, entry] of this.store) {
      if (now >= entry.state.expiresAt) {
        this.store.delete(key);
        evictedCount++;
      }
    }

    if (evictedCount > 0) {
      this.logger?.debug({ evictedCount, remainingCount: this.store.size }, 'Sweep completed');
    }
  }

  /**
   * Evict entries when high water mark is reached.
   *
   * Strategy:
   * 1. First, evict all expired entries
   * 2. If still above threshold, evict oldest entries by lastAccessedAt
   */
  private evictEntries(): void {
    const now = Date.now();
    const targetSize = this.options.highWaterMark - this.options.evictionCount;
    let evictedCount = 0;

    // Phase 1: Evict expired entries
    for (const [key, entry] of this.store) {
      if (this.store.size <= targetSize) {
        break;
      }

      if (now >= entry.state.expiresAt) {
        this.store.delete(key);
        evictedCount++;
      }
    }

    // Phase 2: If still over limit, evict oldest accessed entries
    if (this.store.size > targetSize) {
      // Sort entries by last accessed time
      const entries = Array.from(this.store.entries()).sort(
        (a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt
      );

      const toEvict = this.store.size - targetSize;

      for (let i = 0; i < toEvict && i < entries.length; i++) {
        const entry = entries[i];
        if (entry) {
          this.store.delete(entry[0]);
          evictedCount++;
        }
      }
    }

    this.logger?.warn(
      {
        evictedCount,
        remainingCount: this.store.size,
        highWaterMark: this.options.highWaterMark,
      },
      'High water mark eviction triggered'
    );
  }

  /**
   * Check if the store has been shutdown.
   */
  private checkShutdown(): void {
    if (this.isShutdown) {
      throw new Error('MemoryStore has been shutdown');
    }
  }

  /**
   * Get store statistics for monitoring.
   */
  getStats(): {
    size: number;
    highWaterMark: number;
    utilizationPercent: number;
  } {
    const size = this.store.size;
    return {
      size,
      highWaterMark: this.options.highWaterMark,
      utilizationPercent: (size / this.options.highWaterMark) * 100,
    };
  }
}

/**
 * Create a memory store with sensible defaults.
 *
 * @param options - Optional configuration
 * @param logger - Optional logger
 * @returns A new MemoryStore instance
 */
export function createMemoryStore(options?: MemoryStoreOptions, logger?: Logger): MemoryStore {
  return new MemoryStore(options, logger);
}
