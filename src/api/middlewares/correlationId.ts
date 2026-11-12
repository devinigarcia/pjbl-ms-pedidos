import { randomUUID } from 'node:crypto';
import type { RequestHandler, Response } from 'express';

export const CORRELATION_HEADER = 'x-correlation-id';

// Aceita só valores "comportados" vindos de fora; qualquer outra coisa é trocada por um UUID novo.
const SAFE_VALUE = /^[\w.:-]{1,100}$/;

/**
 * Reaproveita o `x-correlation-id` da requisição (o BFF manda o dele) ou gera um.
 * O valor volta no cabeçalho da resposta, entra nos logs e vai dentro do evento publicado.
 */
export function correlationId(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.header(CORRELATION_HEADER);
    const id = incoming && SAFE_VALUE.test(incoming) ? incoming : randomUUID();
    res.locals.correlationId = id;
    res.setHeader(CORRELATION_HEADER, id);
    next();
  };
}

export function getCorrelationId(res: Response): string {
  return String(res.locals.correlationId ?? '');
}
