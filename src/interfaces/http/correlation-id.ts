import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const CORRELATION_ID_HEADER = 'x-correlation-id';
const VALID_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * pino-http `genReqId`: reuse a well-formed incoming X-Correlation-Id or mint one, echo it on the
 * response and make it the request id, so every log line of the request carries it.
 */
export function resolveCorrelationId(request: IncomingMessage, response: ServerResponse): string {
  const incoming = request.headers[CORRELATION_ID_HEADER];
  const correlationId =
    typeof incoming === 'string' && VALID_CORRELATION_ID.test(incoming)
      ? incoming
      : Bun.randomUUIDv7();
  response.setHeader('X-Correlation-Id', correlationId);
  return correlationId;
}

/** Controller parameter: the request's correlation id (set by pino-http as `req.id`). */
export const CorrelationId = createParamDecorator((_: unknown, context: ExecutionContext): string => {
  const request = context.switchToHttp().getRequest<{ id?: unknown }>();
  return typeof request.id === 'string' ? request.id : Bun.randomUUIDv7();
});
