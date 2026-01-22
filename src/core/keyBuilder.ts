/**
 * Key Builder for Rate Limiting
 *
 * Constructs composite keys from multiple dimensions (ip, emailHash, etc.).
 * Keys are used to identify unique rate limit buckets in the store.
 *
 * Key format: action:ruleName:dimension1=value1:dimension2=value2
 * Example: password_reset_request:per_ip:ip=192.168.1.1
 * Example: password_reset_request:per_email:emailHash=abc123...
 */

import type { KeyDimension, KeyExtractor, RequestContext, RateLimitRule } from './types.js';

/**
 * Separator used between key components.
 */
const KEY_SEPARATOR = ':';

/**
 * Separator between dimension name and value.
 */
const VALUE_SEPARATOR = '=';

/**
 * Default key extractor that reads values directly from the request context.
 */
export class DefaultKeyExtractor implements KeyExtractor {
  extract(dimension: KeyDimension, context: RequestContext): string | undefined {
    switch (dimension) {
      case 'ip':
        return context.ip;
      case 'emailHash':
        return context.emailHash;
      case 'phoneHash':
        return context.phoneHash;
      case 'userId':
        return context.userId;
      case 'sessionId':
        return context.sessionId;
      case 'action':
        return context.action;
      case 'route':
        return context.route;
      default:
        // Check for custom dimension in context
        return context[dimension];
    }
  }
}

/**
 * Default extractor instance.
 */
export const defaultKeyExtractor = new DefaultKeyExtractor();

/**
 * Build a rate limit key for a specific rule and request context.
 *
 * @param action - The action being performed (e.g., 'password_reset_request')
 * @param rule - The rate limit rule
 * @param context - The request context
 * @param extractor - Key extractor to use (defaults to DefaultKeyExtractor)
 * @returns The composite key, or undefined if any required dimension is missing
 *
 * @example
 * ```typescript
 * const key = buildKey(
 *   'password_reset_request',
 *   { name: 'per_ip', key: ['ip'], ... },
 *   { action: 'password_reset_request', ip: '192.168.1.1' }
 * );
 * // Returns: 'password_reset_request:per_ip:ip=192.168.1.1'
 * ```
 */
export function buildKey(
  action: string,
  rule: RateLimitRule,
  context: RequestContext,
  extractor: KeyExtractor = defaultKeyExtractor
): string | undefined {
  const parts: string[] = [action, rule.name];
  const extractedValues: Record<string, string> = {};

  // Extract all dimension values
  for (const dimension of rule.key) {
    const value = extractor.extract(dimension, context);

    if (value === undefined || value === '') {
      // Missing required dimension - cannot build key
      return undefined;
    }

    extractedValues[dimension] = value;
    parts.push(`${dimension}${VALUE_SEPARATOR}${sanitizeValue(value)}`);
  }

  return parts.join(KEY_SEPARATOR);
}

/**
 * Build keys for all rules in a policy.
 *
 * @param action - The action being performed
 * @param rules - Array of rate limit rules
 * @param context - The request context
 * @param extractor - Key extractor to use
 * @returns Map of rule name to key (undefined values for rules with missing dimensions)
 */
export function buildKeysForRules(
  action: string,
  rules: RateLimitRule[],
  context: RequestContext,
  extractor: KeyExtractor = defaultKeyExtractor
): Map<string, string | undefined> {
  const keys = new Map<string, string | undefined>();

  for (const rule of rules) {
    keys.set(rule.name, buildKey(action, rule, context, extractor));
  }

  return keys;
}

/**
 * Parse a key back into its components.
 * Useful for debugging and logging.
 *
 * @param key - The composite key
 * @returns Parsed key components
 */
export function parseKey(key: string): {
  action: string;
  ruleName: string;
  dimensions: Record<string, string>;
} | null {
  const parts = key.split(KEY_SEPARATOR);

  if (parts.length < 2) {
    return null;
  }

  const action = parts[0];
  const ruleName = parts[1];

  if (!action || !ruleName) {
    return null;
  }

  const dimensions: Record<string, string> = {};

  for (let i = 2; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;

    const eqIndex = part.indexOf(VALUE_SEPARATOR);
    if (eqIndex === -1) continue;

    const dimName = part.substring(0, eqIndex);
    const dimValue = part.substring(eqIndex + 1);

    if (dimName) {
      dimensions[dimName] = dimValue;
    }
  }

  return { action, ruleName, dimensions };
}

/**
 * Sanitize a value for use in a key.
 * Replaces separator characters to avoid parsing issues.
 *
 * @param value - The value to sanitize
 * @returns Sanitized value
 */
function sanitizeValue(value: string): string {
  // Replace colons and equals signs to avoid parsing issues
  return value.replace(/[:=]/g, '_');
}

/**
 * Extract all dimension values from context for logging.
 * Masks sensitive values.
 *
 * @param context - The request context
 * @param dimensions - Dimensions to extract
 * @returns Object with dimension values (sensitive values masked)
 */
export function extractDimensionsForLogging(
  context: RequestContext,
  dimensions: KeyDimension[]
): Record<string, string> {
  const result: Record<string, string> = {};
  const extractor = defaultKeyExtractor;

  for (const dim of dimensions) {
    const value = extractor.extract(dim, context);
    if (value !== undefined) {
      // Mask hash values for privacy
      if (dim === 'emailHash' || dim === 'phoneHash') {
        result[dim] = maskHash(value);
      } else {
        result[dim] = value;
      }
    }
  }

  return result;
}

/**
 * Mask a hash value for logging.
 * Shows first 8 characters followed by '...'.
 *
 * @param hash - The hash to mask
 * @returns Masked hash
 */
function maskHash(hash: string): string {
  if (hash.length <= 8) {
    return hash;
  }
  return hash.substring(0, 8) + '...';
}

/**
 * Validate that all required dimensions can be extracted.
 *
 * @param context - The request context
 * @param dimensions - Required dimensions
 * @param extractor - Key extractor to use
 * @returns Array of missing dimension names
 */
export function validateDimensions(
  context: RequestContext,
  dimensions: KeyDimension[],
  extractor: KeyExtractor = defaultKeyExtractor
): KeyDimension[] {
  const missing: KeyDimension[] = [];

  for (const dim of dimensions) {
    const value = extractor.extract(dim, context);
    if (value === undefined || value === '') {
      missing.push(dim);
    }
  }

  return missing;
}
