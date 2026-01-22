/**
 * Memory Store Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryStore } from '../../src/stores/memoryStore.js';
import { TokenBucketState } from '../../src/core/types.js';

describe('MemoryStore', () => {
  let store: MemoryStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new MemoryStore({
      sweepIntervalMs: 60_000,
      highWaterMark: 100,
      evictionCount: 10,
    });
  });

  afterEach(async () => {
    await store.shutdown();
    vi.useRealTimers();
  });

  function createState(tokens: number, expiresInMs: number): TokenBucketState {
    const now = Date.now();
    return {
      tokens,
      lastRefillTime: now,
      createdAt: now,
      expiresAt: now + expiresInMs,
    };
  }

  describe('Basic Operations', () => {
    it('should set and get a value', async () => {
      const state = createState(10, 5000);
      await store.set('key1', state, 5000);

      const retrieved = await store.get('key1');
      expect(retrieved).toEqual(state);
    });

    it('should return undefined for non-existent key', async () => {
      const result = await store.get('nonexistent');
      expect(result).toBeUndefined();
    });

    it('should update existing key', async () => {
      const state1 = createState(10, 5000);
      const state2 = createState(5, 5000);

      await store.set('key1', state1, 5000);
      await store.set('key1', state2, 5000);

      const retrieved = await store.get('key1');
      expect(retrieved?.tokens).toBe(5);
    });

    it('should delete a key', async () => {
      const state = createState(10, 5000);
      await store.set('key1', state, 5000);

      await store.delete('key1');

      const result = await store.get('key1');
      expect(result).toBeUndefined();
    });

    it('should check if key exists', async () => {
      const state = createState(10, 5000);

      expect(await store.has('key1')).toBe(false);

      await store.set('key1', state, 5000);

      expect(await store.has('key1')).toBe(true);
    });

    it('should return correct size', async () => {
      expect(await store.size()).toBe(0);

      await store.set('key1', createState(10, 5000), 5000);
      expect(await store.size()).toBe(1);

      await store.set('key2', createState(10, 5000), 5000);
      expect(await store.size()).toBe(2);

      await store.delete('key1');
      expect(await store.size()).toBe(1);
    });

    it('should clear all keys', async () => {
      await store.set('key1', createState(10, 5000), 5000);
      await store.set('key2', createState(10, 5000), 5000);
      await store.set('key3', createState(10, 5000), 5000);

      expect(await store.size()).toBe(3);

      await store.clear();

      expect(await store.size()).toBe(0);
    });
  });

  describe('TTL and Expiration', () => {
    it('should return undefined for expired entries on get', async () => {
      const state = createState(10, 1000); // Expires in 1 second
      await store.set('key1', state, 1000);

      // Before expiry
      expect(await store.get('key1')).toBeDefined();

      // Advance time past expiry
      vi.advanceTimersByTime(1500);

      // After expiry - lazy eviction
      expect(await store.get('key1')).toBeUndefined();
    });

    it('should return false for has() on expired entries', async () => {
      const state = createState(10, 1000);
      await store.set('key1', state, 1000);

      expect(await store.has('key1')).toBe(true);

      vi.advanceTimersByTime(1500);

      expect(await store.has('key1')).toBe(false);
    });

    it('should delete expired entry on get (lazy eviction)', async () => {
      const state = createState(10, 1000);
      await store.set('key1', state, 1000);

      vi.advanceTimersByTime(1500);

      // This get should trigger deletion
      await store.get('key1');

      // Size should be 0 now
      expect(await store.size()).toBe(0);
    });
  });

  describe('Periodic Sweeper', () => {
    it('should sweep expired entries periodically', async () => {
      // Add some entries with different expiry times
      await store.set('key1', createState(10, 30_000), 30_000);
      await store.set('key2', createState(10, 30_000), 30_000);
      await store.set('key3', createState(10, 90_000), 90_000);

      expect(await store.size()).toBe(3);

      // Advance time to expire first two entries
      vi.advanceTimersByTime(35_000);

      // Entries not yet swept (sweeper runs at 60s)
      expect(await store.size()).toBe(3);

      // Advance to trigger sweeper (total 65s, sweeper at 60s)
      vi.advanceTimersByTime(30_000);

      // Now sweeper should have run
      expect(await store.size()).toBe(1);
    });

    it('should not prevent process exit (unref timer)', async () => {
      // This is more of a design assertion - the timer should be unref'd
      // We can't easily test this, but we can verify the store works
      await store.set('key1', createState(10, 5000), 5000);
      expect(await store.get('key1')).toBeDefined();
    });
  });

  describe('High Water Mark', () => {
    it('should trigger eviction when high water mark is reached', async () => {
      // Fill to high water mark (100)
      for (let i = 0; i < 100; i++) {
        await store.set(`key${i}`, createState(10, 60_000), 60_000);
      }

      expect(await store.size()).toBe(100);

      // Adding one more should trigger eviction
      await store.set('key100', createState(10, 60_000), 60_000);

      // Should have evicted some entries (100 - 10 + 1 = 91)
      expect(await store.size()).toBeLessThanOrEqual(91);
    });

    it('should prefer evicting expired entries first', async () => {
      // Add 90 non-expired entries
      for (let i = 0; i < 90; i++) {
        await store.set(`good${i}`, createState(10, 60_000), 60_000);
      }

      // Add 10 already-expired entries
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        const state: TokenBucketState = {
          tokens: 10,
          lastRefillTime: now - 10_000,
          createdAt: now - 10_000,
          expiresAt: now - 5000, // Already expired
        };
        await store.set(`expired${i}`, state, 1);
      }

      expect(await store.size()).toBe(100);

      // Adding one more should trigger eviction
      await store.set('trigger', createState(10, 60_000), 60_000);

      // The 10 expired entries should be evicted first
      // Size should be around 91 (100 - 10 + 1)
      const size = await store.size();
      expect(size).toBeLessThanOrEqual(91);

      // Verify non-expired entries are still there
      expect(await store.has('good0')).toBe(true);
      expect(await store.has('good89')).toBe(true);
    });

    it('should evict oldest entries if no expired entries', async () => {
      // Fill with non-expired entries, each 10ms apart
      for (let i = 0; i < 100; i++) {
        await store.set(`key${i}`, createState(10, 120_000), 120_000);
        vi.advanceTimersByTime(10);
      }

      // Adding one more should trigger eviction
      await store.set('newkey', createState(10, 60_000), 60_000);

      // Oldest entries (key0, key1, etc.) should be evicted
      const size = await store.size();
      expect(size).toBeLessThanOrEqual(91);
    });
  });

  describe('Shutdown', () => {
    it('should clear store on shutdown', async () => {
      await store.set('key1', createState(10, 5000), 5000);
      await store.set('key2', createState(10, 5000), 5000);

      await store.shutdown();

      // After shutdown, operations should throw
      await expect(store.get('key1')).rejects.toThrow('shutdown');
    });

    it('should stop sweeper on shutdown', async () => {
      await store.shutdown();

      // Multiple shutdowns should be safe
      await store.shutdown();
    });

    it('should throw on operations after shutdown', async () => {
      await store.shutdown();

      await expect(store.get('key1')).rejects.toThrow('shutdown');
      await expect(store.set('key1', createState(10, 5000), 5000)).rejects.toThrow('shutdown');
      await expect(store.delete('key1')).rejects.toThrow('shutdown');
      await expect(store.has('key1')).rejects.toThrow('shutdown');
      await expect(store.size()).rejects.toThrow('shutdown');
      await expect(store.clear()).rejects.toThrow('shutdown');
    });
  });

  describe('Stats', () => {
    it('should return accurate stats', async () => {
      await store.set('key1', createState(10, 5000), 5000);
      await store.set('key2', createState(10, 5000), 5000);
      await store.set('key3', createState(10, 5000), 5000);

      const stats = store.getStats();

      expect(stats.size).toBe(3);
      expect(stats.highWaterMark).toBe(100);
      expect(stats.utilizationPercent).toBe(3);
    });
  });

  describe('Concurrent Access', () => {
    it('should handle concurrent sets safely', async () => {
      const promises = [];
      for (let i = 0; i < 50; i++) {
        promises.push(store.set(`key${i}`, createState(10, 60_000), 60_000));
      }

      await Promise.all(promises);

      expect(await store.size()).toBe(50);
    });

    it('should handle concurrent gets safely', async () => {
      // Pre-populate
      for (let i = 0; i < 20; i++) {
        await store.set(`key${i}`, createState(10, 60_000), 60_000);
      }

      // Concurrent reads
      const promises = [];
      for (let i = 0; i < 100; i++) {
        promises.push(store.get(`key${i % 20}`));
      }

      const results = await Promise.all(promises);

      // All should succeed
      expect(results.filter((r) => r !== undefined).length).toBe(100);
    });

    it('should handle mixed concurrent operations', async () => {
      const operations = [];

      for (let i = 0; i < 50; i++) {
        operations.push(store.set(`key${i}`, createState(10, 60_000), 60_000));
        operations.push(store.get(`key${Math.floor(i / 2)}`));
        if (i % 5 === 0) {
          operations.push(store.delete(`key${i}`));
        }
      }

      await Promise.all(operations);

      // Store should be in consistent state
      const size = await store.size();
      expect(size).toBeLessThanOrEqual(50);
    });
  });
});
