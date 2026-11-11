// Inbound contracts shared by HTTP and SQS. zod checks the JSON shape and rejects unknown fields
// (.strict()); money semantics (decimal format, scale, currency) are validated by the domain `Money`.
import { z } from 'zod';
import { ApiError } from './http/errors/api-error';

const identifier = z.string().trim().min(1).max(128);

export const moneySchema = z
  .object({
    amount: z.string(),
    currency: z.string(),
  })
  .strict();

export const openWalletSchema = z
  .object({
    playerId: identifier,
    initialBalance: moneySchema,
  })
  .strict();

/** OPENING is internal and deliberately absent. */
export const SUBMITTABLE_KINDS = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;

export const submitWagerTransactionSchema = z
  .object({
    providerId: identifier,
    externalTransactionId: identifier,
    playerId: identifier,
    walletId: identifier,
    roundId: identifier,
    gameId: identifier,
    kind: z.enum(SUBMITTABLE_KINDS),
    money: moneySchema,
    referenceExternalTransactionId: identifier.optional(),
  })
  .strict();

export const idempotencyKeySchema = z
  .string({ required_error: 'Idempotency-Key header is required' })
  .trim()
  .min(1, 'Idempotency-Key header is required')
  .max(255)
  .regex(/^[\x21-\x7e]+$/, 'Idempotency-Key must be printable ASCII without spaces');

/** SQS message (§10). `data` is the HTTP body plus the idempotency key. */
export const wagerTransactionRequestedSchema = z
  .object({
    messageId: identifier,
    type: z.literal('WagerTransactionRequested'),
    occurredAt: z.string().datetime({ offset: true }),
    data: submitWagerTransactionSchema.extend({ idempotencyKey: idempotencyKeySchema }).strict(),
  })
  .strict();

export type WagerTransactionRequested = z.output<typeof wagerTransactionRequestedSchema>;

export const ledgerQuerySchema = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

/** Parses an HTTP input or throws a 400 ApiError. */
export function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw ApiError.validation('Invalid request', {
      issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return result.data;
}
