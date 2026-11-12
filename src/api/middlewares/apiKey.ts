import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { HttpError } from './errorHandler';

export const API_KEY_HEADER = 'x-api-key';

/**
 * Quando INTERNAL_API_KEY está definida, só passa quem mandar o mesmo valor em `x-api-key`
 * (na nuvem, quem chama é o BFF). Sem a variável o serviço fica aberto, o que facilita o desenvolvimento.
 *
 * As rotas públicas (/health, /docs, /openapi.json, /events/docs, /events/asyncapi.*)
 * são registradas ANTES deste middleware no app.ts, por isso não passam por aqui.
 */
export function apiKey(expectedKey: string | undefined): RequestHandler {
  if (!expectedKey) {
    return (_req, _res, next) => next();
  }

  const expectedDigest = digest(expectedKey);
  return (req, _res, next) => {
    // preflight de CORS não leva cabeçalhos personalizados
    if (req.method === 'OPTIONS') {
      next();
      return;
    }
    const provided = req.header(API_KEY_HEADER);
    // compara os hashes em tempo constante para não vazar a chave pelo tempo de resposta
    if (provided && timingSafeEqual(digest(provided), expectedDigest)) {
      next();
      return;
    }
    next(new HttpError(401, 'UNAUTHORIZED', 'Chave de acesso ausente ou inválida (cabeçalho x-api-key).'));
  };
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
