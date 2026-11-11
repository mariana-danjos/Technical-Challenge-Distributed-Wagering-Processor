import { TransientInfrastructureError } from '../../application/errors';
import { payloadHash } from '../../application/idempotency/payload-hash';
import type { SubmitWagerTransaction } from '../../application/wagering/submit-wager-transaction';
import { DomainError, InvalidTransactionStateError } from '../../domain/shared/domain-error';
import type { MessageAction, MessageHandler } from '../../infrastructure/messaging/sqs-queue-consumer';
import { wagerTransactionRequestedSchema } from '../contracts';

/**
 * Adapts `WagerTransactionRequested` deliveries to the same use case as HTTP and classifies the
 * outcome:
 *   business outcome (processed, rejected, pending, idempotency conflict, unknown wallet) → ack
 *   duplicate delivery (inbox)                                                             → ack
 *   malformed envelope / invalid payload / same messageId with another payload             → DLQ
 *   transient infrastructure failure, or anything unexpected                               → retry
 */
export class WagerTransactionMessageHandler implements MessageHandler {
  constructor(
    private readonly submitWagerTransaction: SubmitWagerTransaction,
    private readonly consumerName: string,
  ) {}

  async handle(body: string): Promise<MessageAction> {
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return { kind: 'dlq', reason: 'MALFORMED_JSON' };
    }
    const parsed = wagerTransactionRequestedSchema.safeParse(json);
    if (!parsed.success) {
      return { kind: 'dlq', reason: 'INVALID_MESSAGE' };
    }

    const { messageId, data } = parsed.data;
    const context = {
      messageId,
      providerId: data.providerId,
      walletId: data.walletId,
      externalTransactionId: data.externalTransactionId,
    };
    try {
      const result = await this.submitWagerTransaction.execute(
        { ...data, correlationId: messageId, causationId: messageId },
        {
          inbox: {
            consumerName: this.consumerName,
            messageId,
            // Business content only: a producer re-sending the same operation with a new
            // occurredAt is a duplicate, not a conflicting payload.
            payloadHash: payloadHash({ type: parsed.data.type, data: parsed.data.data }),
          },
        },
      );
      switch (result.outcome) {
        case 'MESSAGE_PAYLOAD_CONFLICT':
          return { kind: 'dlq', reason: 'MESSAGE_PAYLOAD_CONFLICT', context };
        case 'RECORDED':
          return {
            kind: 'ack',
            context: { ...context, outcome: result.outcome, transactionId: result.transactionId, status: result.status },
          };
        default:
          return { kind: 'ack', context: { ...context, outcome: result.outcome } };
      }
    } catch (error) {
      if (error instanceof DomainError && !(error instanceof InvalidTransactionStateError)) {
        return { kind: 'dlq', reason: 'INVALID_PAYLOAD', context };
      }
      if (error instanceof TransientInfrastructureError) {
        return { kind: 'retry', reason: 'TRANSIENT_INFRASTRUCTURE', context };
      }
      throw error;
    }
  }
}
