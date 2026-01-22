/**
 * Hashing utilities for secure identifier handling.
 *
 * IMPORTANT: Never store raw email addresses or phone numbers in rate limit keys.
 * Always use HMAC hashing to prevent information leakage if the store is compromised.
 */

import { createHmac } from 'crypto';

/**
 * Hash an identifier (email, phone, etc.) using HMAC-SHA256.
 *
 * This function should be used to hash sensitive identifiers before
 * using them as rate limit keys. The same identifier with the same
 * secret will always produce the same hash, enabling rate limiting
 * without storing the raw identifier.
 *
 * @param identifier - The raw identifier to hash (e.g., email, phone)
 * @param secret - The HMAC secret key
 * @returns Hexadecimal hash string
 *
 * @example
 * ```typescript
 * const emailHash = hashIdentifier('user@example.com', process.env.HASH_SECRET);
 * // Use emailHash in rate limit key instead of raw email
 * ```
 */
export function hashIdentifier(identifier: string, secret: string): string {
  if (!identifier) {
    throw new Error('Identifier cannot be empty');
  }

  if (!secret) {
    throw new Error('Secret cannot be empty');
  }

  // Normalize the identifier (lowercase for emails)
  const normalized = identifier.toLowerCase().trim();

  // Create HMAC-SHA256 hash
  const hmac = createHmac('sha256', secret);
  hmac.update(normalized);

  return hmac.digest('hex');
}

/**
 * Hash an email address for rate limiting.
 * Normalizes the email before hashing.
 *
 * @param email - The email address to hash
 * @param secret - The HMAC secret key
 * @returns Hexadecimal hash string
 */
export function hashEmail(email: string, secret: string): string {
  // Basic email normalization
  const normalized = email.toLowerCase().trim();
  return hashIdentifier(normalized, secret);
}

/**
 * Hash a phone number for rate limiting.
 * Strips non-digit characters before hashing.
 *
 * @param phone - The phone number to hash
 * @param secret - The HMAC secret key
 * @returns Hexadecimal hash string
 */
export function hashPhone(phone: string, secret: string): string {
  // Strip non-digit characters for normalization
  const normalized = phone.replace(/\D/g, '');

  if (!normalized) {
    throw new Error('Phone number must contain digits');
  }

  return hashIdentifier(normalized, secret);
}

/**
 * Verify that two identifiers produce the same hash.
 * Useful for testing/debugging without exposing raw identifiers.
 *
 * @param identifier1 - First identifier
 * @param identifier2 - Second identifier
 * @param secret - The HMAC secret key
 * @returns True if both identifiers hash to the same value
 */
export function hashesMatch(identifier1: string, identifier2: string, secret: string): boolean {
  const hash1 = hashIdentifier(identifier1, secret);
  const hash2 = hashIdentifier(identifier2, secret);

  // Use timing-safe comparison to prevent timing attacks
  if (hash1.length !== hash2.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < hash1.length; i++) {
    result |= hash1.charCodeAt(i) ^ hash2.charCodeAt(i);
  }

  return result === 0;
}
