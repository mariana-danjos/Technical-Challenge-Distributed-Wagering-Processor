// Request contracts. zod checks the JSON shape and rejects unknown fields (.strict()); money
// semantics (decimal format, scale, currency) are validated by the domain `Money`.
import { z } from 'zod';
import { ApiError } from './errors/api-error';

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

export const ledgerQuerySchema = z
  .object({
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw ApiError.validation('Invalid request', {
      issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return result.data;
}
