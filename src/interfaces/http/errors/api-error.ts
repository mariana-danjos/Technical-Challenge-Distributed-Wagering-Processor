/**
 * Stable API error codes. Together with the HTTP status they tell a provider whether to resend:
 * 4xx codes never succeed on retry with the same payload, 503 does.
 */
export enum ApiErrorCode {
  ValidationError = 'VALIDATION_ERROR',
  IdempotencyConflict = 'IDEMPOTENCY_CONFLICT',
  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletAlreadyExists = 'WALLET_ALREADY_EXISTS',
  NotFound = 'NOT_FOUND',
  Unauthorized = 'UNAUTHORIZED',
  TemporarilyUnavailable = 'TEMPORARILY_UNAVAILABLE',
  InternalError = 'INTERNAL_ERROR',
}

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode | string;
    message: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static notFound(what: string): ApiError {
    return new ApiError(404, ApiErrorCode.NotFound, `${what} not found`);
  }

  static validation(message: string, details?: unknown): ApiError {
    return new ApiError(400, ApiErrorCode.ValidationError, message, details);
  }
}
