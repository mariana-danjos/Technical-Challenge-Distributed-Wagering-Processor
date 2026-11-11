import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { TransientInfrastructureError } from '../../../application/errors';
import { DomainError, InvalidTransactionStateError } from '../../../domain/shared/domain-error';
import { ApiError, ApiErrorCode, type ApiErrorBody } from './api-error';

export const RETRY_AFTER_SECONDS = 1;

export interface ErrorResponse {
  status: number;
  body: ApiErrorBody;
  headers: Record<string, string>;
}

/** Single mapping from failures to HTTP, shared by every endpoint. */
export function toErrorResponse(exception: unknown): ErrorResponse {
  if (exception instanceof ApiError) {
    return response(exception.status, exception.code, exception.message, exception.details);
  }
  // Invalid input caught by domain factories (money format, currency, missing reference…).
  // An illegal state transition is a programming error and falls through to 500.
  if (exception instanceof DomainError && !(exception instanceof InvalidTransactionStateError)) {
    return response(400, ApiErrorCode.ValidationError, exception.message);
  }
  if (exception instanceof TransientInfrastructureError) {
    return {
      ...response(503, ApiErrorCode.TemporarilyUnavailable, 'Temporarily unavailable, retry with the same Idempotency-Key'),
      headers: { 'Retry-After': String(RETRY_AFTER_SECONDS) },
    };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const code =
      status === 404
        ? ApiErrorCode.NotFound
        : status === 401
          ? ApiErrorCode.Unauthorized
          : status === 400
            ? ApiErrorCode.ValidationError
            : `HTTP_${status}`;
    return response(status, code, exception.message);
  }
  // Malformed JSON bodies surface from the body parser with a 4xx status.
  const parserError = exception as { type?: string; status?: number };
  if (parserError?.type === 'entity.parse.failed') {
    return response(400, ApiErrorCode.ValidationError, 'Malformed JSON body');
  }
  if (parserError?.type === 'entity.too.large') {
    return response(413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
  }
  return response(500, ApiErrorCode.InternalError, 'Internal error');
}

function response(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): ErrorResponse {
  return {
    status,
    body: { error: { code, message, ...(details !== undefined && { details }) } },
    headers: {},
  };
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const { status, body, headers } = toErrorResponse(exception);
    if (status >= 500) {
      this.logger.error({ err: exception, status }, 'Request failed');
    }
    const res = host.switchToHttp().getResponse<Response>();
    res.status(status).set(headers).json(body);
  }
}
