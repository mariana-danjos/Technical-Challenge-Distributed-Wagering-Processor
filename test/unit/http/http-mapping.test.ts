import { describe, expect, it } from 'bun:test';
import { NotFoundException } from '@nestjs/common';
import { TransientInfrastructureError } from '../../../src/application/errors';
import {
  InvalidMoneyError,
  InvalidTransactionStateError,
} from '../../../src/domain/shared/domain-error';
import { ApiError, ApiErrorCode } from '../../../src/interfaces/http/errors/api-error';
import { toErrorResponse } from '../../../src/interfaces/http/errors/api-exception.filter';
import { LedgerCursor } from '../../../src/interfaces/http/ledger-cursor';

describe('toErrorResponse', () => {
  it.each([
    ['ApiError', new ApiError(409, ApiErrorCode.IdempotencyConflict, 'x'), 409, 'IDEMPOTENCY_CONFLICT'],
    ['invalid domain input', new InvalidMoneyError('bad amount'), 400, 'VALIDATION_ERROR'],
    ['illegal state transition (bug)', new InvalidTransactionStateError('terminal'), 500, 'INTERNAL_ERROR'],
    ['transient infrastructure', new TransientInfrastructureError('lock timeout'), 503, 'TEMPORARILY_UNAVAILABLE'],
    ['Nest NotFoundException', new NotFoundException(), 404, 'NOT_FOUND'],
    ['malformed JSON', Object.assign(new SyntaxError('x'), { type: 'entity.parse.failed', status: 400 }), 400, 'VALIDATION_ERROR'],
    ['unknown error', new Error('boom'), 500, 'INTERNAL_ERROR'],
  ])('%s → %i %s', (_, exception, status, code) => {
    const response = toErrorResponse(exception);

    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
  });

  it('503 carries Retry-After so providers know they may resend', () => {
    expect(toErrorResponse(new TransientInfrastructureError('x')).headers).toEqual({ 'Retry-After': '1' });
  });

  it('never leaks internal error messages', () => {
    expect(toErrorResponse(new Error('password=secret')).body.error.message).toBe('Internal error');
  });
});

describe('LedgerCursor', () => {
  const walletId = crypto.randomUUID();

  it('round-trips a sequence and is opaque', () => {
    const cursor = LedgerCursor.encode(walletId, '12345');

    expect(cursor).not.toContain('12345');
    expect(LedgerCursor.decode(walletId, cursor)).toBe('12345');
  });

  it.each([
    ['garbage', 'not-base64-json'],
    ['another wallet', LedgerCursor.encode(crypto.randomUUID(), '1')],
    ['non-numeric sequence', Buffer.from(JSON.stringify({ v: 1, w: walletId, s: '1; drop' })).toString('base64url')],
    ['unknown version', Buffer.from(JSON.stringify({ v: 2, w: walletId, s: '1' })).toString('base64url')],
  ])('rejects %s with 400', (_, cursor) => {
    expect(() => LedgerCursor.decode(walletId, cursor)).toThrow(ApiError);
  });
});
