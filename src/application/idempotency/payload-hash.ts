import { createHash } from 'node:crypto';

/**
 * Canonical JSON: object keys sorted recursively, `undefined` members dropped, no whitespace.
 * Two payloads with the same business content always produce the same string.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${members.join(',')}}`;
  }
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) {
    return JSON.stringify(value);
  }
  // Business payloads carry money as decimal strings; numbers would make the hash
  // depend on float formatting.
  throw new TypeError(`Unsupported value in canonical JSON: ${typeof value}`);
}

/** payloadHash = lowercase hex SHA-256 of the canonical JSON of the business fields. */
export function payloadHash(businessFields: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(businessFields)).digest('hex');
}
