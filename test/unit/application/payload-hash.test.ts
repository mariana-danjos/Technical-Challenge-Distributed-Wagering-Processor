import { describe, expect, it } from 'bun:test';
import { canonicalJson, payloadHash } from '../../../src/application/idempotency/payload-hash';

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined members', () => {
    expect(canonicalJson({ b: '1', a: { d: true, c: null }, z: undefined })).toBe(
      '{"a":{"c":null,"d":true},"b":"1"}',
    );
  });

  it('rejects numbers so money can never be hashed through float formatting', () => {
    expect(() => canonicalJson({ amount: 25 })).toThrow(TypeError);
  });
});

describe('payloadHash', () => {
  const fields = {
    providerId: 'provider-a',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };

  it('is a lowercase hex SHA-256', () => {
    expect(payloadHash(fields)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not depend on key order', () => {
    expect(
      payloadHash({ money: { currency: 'BRL', amount: '25.00' }, kind: 'BET', providerId: 'provider-a' }),
    ).toBe(payloadHash(fields));
  });

  it('changes when any business field changes', () => {
    expect(payloadHash({ ...fields, money: { amount: '25.01', currency: 'BRL' } })).not.toBe(
      payloadHash(fields),
    );
  });

  it('treats an absent optional field like an undefined one', () => {
    expect(payloadHash({ ...fields, referenceExternalTransactionId: undefined })).toBe(
      payloadHash(fields),
    );
  });
});
