import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { WAGERING_QUERIES, type WageringQueries } from '../../application/ports/queries';
import {
  SubmitWagerTransaction,
  type SubmitWagerTransactionResult,
} from '../../application/wagering/submit-wager-transaction';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import { CorrelationId } from './correlation-id';
import { ApiError, ApiErrorCode } from './errors/api-error';
import { idempotencyKeySchema, parse, submitWagerTransactionSchema } from '../contracts';

/**
 * Status of a recorded transaction → HTTP. A replay returns the same code as the original.
 *   PROCESSED 200 · PENDING_REFERENCE 202 (will be applied later) · REJECTED 422 (business rule;
 *   do not resend unchanged) · FAILED 500.
 */
const STATUS_TO_HTTP: Record<WagerTransactionStatus, number> = {
  [WagerTransactionStatus.Processed]: 200,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Pending]: 202,
  [WagerTransactionStatus.Rejected]: 422,
  [WagerTransactionStatus.Failed]: 500,
};

@Controller()
export class WageringController {
  constructor(
    private readonly submitWagerTransaction: SubmitWagerTransaction,
    @Inject(WAGERING_QUERIES) private readonly queries: WageringQueries,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKeyHeader: unknown,
    @Body() body: unknown,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const idempotencyKey = parse(idempotencyKeySchema, idempotencyKeyHeader);
    const command = parse(submitWagerTransactionSchema, body);

    const result = await this.submitWagerTransaction.execute({ ...command, idempotencyKey, correlationId });
    const { status, body: responseBody } = present(result);
    response.status(status);
    return responseBody;
  }

  @Get('wagering/transactions/:transactionId')
  async get(@Param('transactionId') transactionId: string) {
    const transaction = await this.queries.transaction(transactionId);
    if (!transaction) throw ApiError.notFound('Transaction');
    return transaction;
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const transaction = await this.queries.transactionByExternalId(providerId, externalTransactionId);
    if (!transaction) throw ApiError.notFound('Transaction');
    return transaction;
  }
}

function present(result: SubmitWagerTransactionResult) {
  switch (result.outcome) {
    case 'RECORDED':
      return {
        status: STATUS_TO_HTTP[result.status],
        body: {
          transactionId: result.transactionId,
          status: result.status,
          balance: result.balance,
          ...(result.failureCode && { failureCode: result.failureCode }),
          idempotentReplay: result.idempotentReplay,
        },
      };
    case 'IDEMPOTENCY_CONFLICT':
      throw new ApiError(
        409,
        ApiErrorCode.IdempotencyConflict,
        'Idempotency-Key or external transaction id already used with a different payload',
        { transactionId: result.transactionId },
      );
    case 'WALLET_NOT_FOUND':
      throw new ApiError(404, ApiErrorCode.WalletNotFound, 'Wallet not found');
    case 'DUPLICATE_MESSAGE':
    case 'MESSAGE_PAYLOAD_CONFLICT':
      // Inbox outcomes only exist for queue deliveries; HTTP never passes an inbox receipt.
      throw new Error(`Unexpected outcome for an HTTP request: ${result.outcome}`);
  }
}
