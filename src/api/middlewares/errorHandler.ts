import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from 'pino';
import { ServiceUnavailableError } from '../../application/errors';
import { ConflictError, DomainError, NotFoundError, ValidationError } from '../../domain/errors';
import { getCorrelationId } from './correlationId';

/** Erro que já nasce com status HTTP (usado só pela camada de API: 401, 404 de rota...). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

interface ErrorResponse {
  status: number;
  code: string;
  message: string;
  details?: unknown[];
  /** Vira o cabeçalho Retry-After (segundos). */
  retryAfterSeconds?: number;
}

/** Traduz qualquer erro para o formato padrão `{ error: { code, message, details?, correlationId } }`. */
export function toErrorResponse(error: unknown): ErrorResponse {
  if (error instanceof HttpError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  if (error instanceof DomainError) {
    return {
      status: statusOfDomainError(error),
      code: error.code,
      message: error.message,
      // `details` é sempre uma lista (como no erro de validação), para o front tratar de um jeito só
      details: Array.isArray(error.details) ? error.details : undefined,
    };
  }

  if (error instanceof ServiceUnavailableError) {
    return { status: 503, code: error.code, message: error.message, retryAfterSeconds: error.retryAfterSeconds };
  }

  // Erros do express.json() (body-parser) vêm com `type` e `status`.
  const parserError = error as { type?: string; status?: number } | null;
  if (parserError?.type === 'entity.parse.failed') {
    return { status: 400, code: 'INVALID_JSON', message: 'O corpo da requisição não é um JSON válido.' };
  }
  if (parserError?.type === 'entity.too.large') {
    return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'O corpo da requisição é grande demais.' };
  }
  if (typeof parserError?.status === 'number' && parserError.status >= 400 && parserError.status < 500) {
    return { status: parserError.status, code: 'BAD_REQUEST', message: 'Requisição inválida.' };
  }

  return { status: 500, code: 'INTERNAL_ERROR', message: 'Erro interno. Tente novamente em instantes.' };
}

function statusOfDomainError(error: DomainError): number {
  if (error instanceof ValidationError) return 400;
  if (error instanceof NotFoundError) return 404;
  if (error instanceof ConflictError) return 409;
  return 422; // regra de negócio
}

export function notFoundHandler(): RequestHandler {
  return (req, _res, next) => {
    next(new HttpError(404, 'ROUTE_NOT_FOUND', `Rota não encontrada: ${req.method} ${req.path}`));
  };
}

export function errorHandler(logger: Pick<Logger, 'error'>): ErrorRequestHandler {
  // O Express só reconhece o middleware de erro pelos 4 parâmetros, por isso o `next` fica aqui.
  return (error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const correlationId = getCorrelationId(res);
    const { status, code, message, details, retryAfterSeconds } = toErrorResponse(error);
    if (status >= 500) {
      // o detalhe do erro vai só para o log, nunca para quem chamou
      logger.error({ err: error, correlationId, method: req.method, path: req.path }, 'erro inesperado');
    }

    if (retryAfterSeconds !== undefined) {
      res.setHeader('Retry-After', String(retryAfterSeconds));
    }
    res.status(status).json({
      error: { code, message, ...(details ? { details } : {}), correlationId },
    });
  };
}
